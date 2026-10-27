import { createWriteStream, existsSync, mkdirSync, openAsBlob, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { config } from "./config.ts";
import type { AssetRef, RenderSpec, Template } from "./brand.ts";
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
  | { type: "job"; job: Job; channel: Channel; hasClips: boolean; template: Template | null }
  | { type: "clip"; clip: Clip; job: Job; channel: Channel; spec: RenderSpec }
  | { type: "final"; clip: Clip; job: Job; channel: Channel; spec: RenderSpec };

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

/**
 * Antes de baixar do YouTube: pega no hub a sessão do YouTube logada no navegador do robô
 * (resolve o "confirme que você não é um robô"). Sem sessão lá, segue sem cookies.
 */
async function refreshYoutubeCookies(source: string) {
  if (!/youtu\.?be/.test(source) || existsSync(config.ytdlpCookies)) return;
  try {
    writeFileSync(config.ytdlpRobotCookies, await hub<string>("GET", "/api/worker/youtube-cookies"));
  } catch {
    rmSync(config.ytdlpRobotCookies, { force: true });
  }
}

async function processJob({ job, channel, hasClips, template }: Extract<Task, { type: "job" }>) {
  const report = (fields: Record<string, unknown>) => hub("POST", `/api/worker/jobs/${job.id}`, fields);
  const dir = jobDir(job.id);
  try {
    await refreshYoutubeCookies(job.source);
    const src = await fetchSource(job.id, job.source, progress((d) => report({ detail: d })));
    await report({ video_url: src.videoUrl, video_id: src.videoId, title: src.title, uploader: src.uploader ?? "", duration: src.duration, status: "TRANSCRIBING", detail: "" });

    const transcript = await transcribe(dir, src.path, progress((d) => report({ detail: d })));
    await hub("PUT", `/api/worker/jobs/${job.id}/transcript`, undefined, join(dir, "transcript.json"));

    if (hasClips) {
      await report({ status: "RENDERING", detail: "" }); // retry de job já analisado: não paga a IA de novo
      return;
    }
    await report({ status: "ANALYZING", detail: `${transcript.words.length} palavras` });
    const { cuts, usage } = await analyze(channel, template, transcript, src.title);
    await report({ ...usage });
    await hub("POST", `/api/worker/jobs/${job.id}/clips`, { cuts });
  } catch (e) {
    await report({ status: "FAILED", error: errMsg(e) }).catch(() => {});
    console.error(`[worker] job #${job.id}: ${errMsg(e)}`);
  }
}

async function processClip({ clip, job, channel, spec }: Extract<Task, { type: "clip" }>) {
  const report = (fields: Record<string, unknown>) => hub("POST", `/api/worker/clips/${clip.id}`, fields);
  const dir = jobDir(job.id);
  try {
    const src = await fetchSource(job.id, job.source, progress((d) => report({ detail: `baixando fonte ${d}` })));
    if (!existsSync(join(dir, "transcript.json"))) {
      writeFileSync(join(dir, "transcript.json"), await hub<string>("GET", `/api/worker/jobs/${job.id}/transcript`));
    }
    const assets = await fetchAssets(spec);
    const layout = await renderClip(clip, channel, spec, assets, dir, src.path, loadTranscript(dir), progress((d) => report({ detail: d })));
    await report({ detail: "gerando proxy" });
    const proxy = await makeProxy(clip, dir, src.path, src.duration);
    await report({ detail: "enviando ao hub" });
    // O mp4 final fica aqui no PC; o hub pede quando o corte estiver perto de ser publicado.
    for (const kind of ["jpg", "proxy", "preview"] as const) {
      await hub("PUT", `/api/worker/clips/${clip.id}/files/${kind}`, undefined, clipFile(dir, clip.id, kind));
    }
    await hub("POST", `/api/worker/clips/${clip.id}/done`, { layout_used: layout, ...proxy });
  } catch (e) {
    await report({ status: "FAILED", error: errMsg(e) }).catch(() => {});
    console.error(`[worker] corte #${clip.id}: ${errMsg(e)}`);
  }
}

/** Envia ao hub o vídeo final de um corte que vai ser publicado em breve (renderiza de novo se sumiu daqui). */
async function processFinal({ clip, job, channel, spec }: Extract<Task, { type: "final" }>) {
  const dir = jobDir(job.id);
  const file = clipFile(dir, clip.id, "mp4");
  try {
    if (!existsSync(file)) {
      currentTask = `re-renderizando corte #${clip.id} para publicação`;
      const src = await fetchSource(job.id, job.source, () => {});
      if (!existsSync(join(dir, "transcript.json"))) {
        writeFileSync(join(dir, "transcript.json"), await hub<string>("GET", `/api/worker/jobs/${job.id}/transcript`));
      }
      await renderClip(clip, channel, spec, await fetchAssets(spec), dir, src.path, loadTranscript(dir), () => {});
    }
    await hub("PUT", `/api/worker/clips/${clip.id}/files/mp4`, undefined, file);
    await hub("POST", `/api/worker/clips/${clip.id}/final`, {});
  } catch (e) {
    await hub("POST", `/api/worker/clips/${clip.id}/final`, { error: errMsg(e) }).catch(() => {});
    console.error(`[worker] vídeo final do corte #${clip.id}: ${errMsg(e)}`);
  }
}

/** Baixa (uma vez) os assets do canal usados no corte. Assets são imutáveis: id novo a cada upload. */
async function fetchAssets(spec: RenderSpec): Promise<Map<number, string>> {
  const dir = join(config.workDir, "assets");
  mkdirSync(dir, { recursive: true });
  const refs = [spec.intro, spec.outro, spec.cta?.asset, spec.logo?.asset, spec.music?.asset].filter((a): a is AssetRef => !!a);
  const out = new Map<number, string>();
  for (const a of refs) {
    const file = join(dir, `${a.id}.${a.ext}`);
    if (!existsSync(file)) {
      const r = await fetch(`${config.hubUrl}/api/worker/assets/${a.id}`, { headers: { authorization: `Bearer ${config.workerToken}`, "x-worker": config.workerName } });
      if (!r.ok || !r.body) throw new Error(`asset #${a.id}: HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body as WebStream), createWriteStream(`${file}.part`));
      renameSync(`${file}.part`, file);
    }
    out.set(a.id, file);
  }
  return out;
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
    currentTask = task.type === "job" ? `job #${task.job.id}` : task.type === "final" ? `enviando vídeo final do corte #${task.clip.id}` : `corte #${task.clip.id}`;
    console.log(`[worker] ${currentTask}`);
    if (task.type === "job") await processJob(task);
    else if (task.type === "final") await processFinal(task);
    else await processClip(task);
    currentTask = "";
  }
}
