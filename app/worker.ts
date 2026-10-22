import { existsSync, openAsBlob, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Channel, Clip, Job } from "./db.ts";
import { analyze } from "./pipeline/analyze.ts";
import { clipFile, makeProxy, renderClip } from "./pipeline/render.ts";
import { fetchSource, jobDir } from "./pipeline/source.ts";
import { loadTranscript, transcribe } from "./pipeline/transcribe.ts";

/**
 * Worker: roda na máquina com CPU/GPU, pede tarefas ao hub e devolve resultados.
 * Não toca no banco — tudo passa pela API /api/worker/* do hub.
 */

type Task =
  | { type: "idle" }
  | { type: "job"; job: Job; channel: Channel; hasClips: boolean }
  | { type: "clip"; clip: Clip; job: Job; channel: Channel };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let currentTask = "";

async function hub<T = unknown>(method: string, path: string, body?: unknown, file?: string): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${config.workerToken}`, "x-worker": config.workerName };
  let payload: BodyInit | undefined;
  if (file) {
    headers["content-type"] = "application/octet-stream";
    payload = await openAsBlob(file);
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(`${config.hubUrl}${path}`, { method, headers, body: payload });
  if (!r.ok) throw new Error(`hub ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return (r.headers.get("content-type")?.includes("json") ? r.json() : r.text()) as Promise<T>;
}

/** Progresso com throttle de 2 s para não inundar o hub. */
function progress(send: (detail: string) => Promise<unknown>) {
  let last = 0;
  return (detail: string) => {
    currentTask = detail;
    if (Date.now() - last < 2000) return;
    last = Date.now();
    send(detail).catch(() => {});
  };
}

async function processJob({ job, channel, hasClips }: Extract<Task, { type: "job" }>) {
  const report = (fields: Record<string, unknown>) => hub("POST", `/api/worker/jobs/${job.id}`, fields);
  const dir = jobDir(job.id);
  try {
    const src = await fetchSource(job.id, job.source, progress((d) => report({ detail: d })));
    await report({ video_url: src.videoUrl, video_id: src.videoId, title: src.title, duration: src.duration, status: "TRANSCRIBING", detail: "" });

    const transcript = await transcribe(dir, src.path, progress((d) => report({ detail: d })));
    await hub("PUT", `/api/worker/jobs/${job.id}/transcript`, undefined, join(dir, "transcript.json"));

    if (hasClips) {
      await report({ status: "RENDERING", detail: "" }); // retry de job já analisado: não paga a IA de novo
      return;
    }
    await report({ status: "ANALYZING", detail: `${transcript.words.length} palavras` });
    const { cuts, usage } = await analyze(channel, transcript, src.title);
    await report({ ...usage });
    await hub("POST", `/api/worker/jobs/${job.id}/clips`, { cuts });
  } catch (e) {
    await report({ status: "FAILED", error: errMsg(e) }).catch(() => {});
    console.error(`[worker] job #${job.id}: ${errMsg(e)}`);
  }
}

async function processClip({ clip, job, channel }: Extract<Task, { type: "clip" }>) {
  const report = (fields: Record<string, unknown>) => hub("POST", `/api/worker/clips/${clip.id}`, fields);
  const dir = jobDir(job.id);
  try {
    const src = await fetchSource(job.id, job.source, progress((d) => report({ detail: `baixando fonte ${d}` })));
    if (!existsSync(join(dir, "transcript.json"))) {
      writeFileSync(join(dir, "transcript.json"), await hub<string>("GET", `/api/worker/jobs/${job.id}/transcript`));
    }
    const layout = await renderClip(clip, channel, dir, src.path, loadTranscript(dir), progress((d) => report({ detail: d })));
    await report({ detail: "gerando proxy" });
    const proxy = await makeProxy(clip, dir, src.path, src.duration);
    await report({ detail: "enviando ao hub" });
    for (const kind of ["mp4", "jpg", "proxy", "preview"] as const) {
      await hub("PUT", `/api/worker/clips/${clip.id}/files/${kind}`, undefined, clipFile(dir, clip.id, kind));
    }
    await hub("POST", `/api/worker/clips/${clip.id}/done`, { layout_used: layout, ...proxy });
  } catch (e) {
    await report({ status: "FAILED", error: errMsg(e) }).catch(() => {});
    console.error(`[worker] corte #${clip.id}: ${errMsg(e)}`);
  }
}

export async function startWorker() {
  if (!config.workerToken) throw new Error("WORKER_TOKEN não definido");
  console.log(`[worker] ${config.workerName} → ${config.hubUrl}`);
  setInterval(() => hub("POST", "/api/worker/heartbeat", { task: currentTask }).catch(() => {}), 30_000);

  let hubDown = false;
  let greeted = false;
  for (;;) {
    if (!greeted) {
      greeted = await hub("POST", "/api/worker/hello", {}).then(() => true, () => false);
      if (!greeted) {
        await sleep(30_000);
        continue;
      }
    }
    let task: Task;
    try {
      task = await hub<Task>("POST", "/api/worker/claim", {});
      if (hubDown) console.log("[worker] hub de volta");
      hubDown = false;
    } catch (e) {
      if (!hubDown) console.error(`[worker] hub inacessível: ${errMsg(e)}`);
      hubDown = true;
      await sleep(30_000);
      continue;
    }
    if (task.type === "idle") {
      currentTask = "";
      await sleep(10_000);
      continue;
    }
    currentTask = task.type === "job" ? `job #${task.job.id}` : `corte #${task.clip.id}`;
    console.log(`[worker] ${currentTask}`);
    if (task.type === "job") await processJob(task);
    else await processClip(task);
    currentTask = "";
  }
}
