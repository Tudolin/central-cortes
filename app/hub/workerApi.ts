import { createWriteStream, existsSync, renameSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { all, get, getChannel, getClip, getJob, run, updateClip, updateJob, type Clip, type Job } from "../db.ts";
import { bus } from "../events.ts";
import { HttpError, must, route, serveFile } from "../http.ts";
import type { CutProposal } from "../pipeline/analyze.ts";
import { renderCaption } from "../pipeline/caption.ts";
import { specFor, templateOf } from "./brandApi.ts";
import { clipPath, transcriptPath, type ClipFile } from "./media.ts";
import { diskState, finalWindowH } from "./disk.ts";
import { rebalance } from "./schedule.ts";
import { tg } from "./telegram.ts";

/**
 * Protocolo hub ↔ worker (pull): o worker pede tarefa, reporta progresso e sobe os arquivos.
 * O hub nunca precisa alcançar o worker — o PC pode ficar desligado e a fila só espera.
 */

const STALE_MS = 3 * 60_000;

function heartbeat(worker: string, task = "") {
  run(
    `INSERT INTO workers (name, last_seen, task) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen, task = excluded.task`,
    worker, new Date().toISOString(), task,
  );
}

const workerOf = (req: IncomingMessage) => String(req.headers["x-worker"] ?? "worker").slice(0, 60);

/** Worker acabou de iniciar: o que estava atribuído a ele ficou pela metade e volta para a fila. */
route("POST", "/api/worker/hello", (req) => {
  const worker = workerOf(req);
  heartbeat(worker);
  for (const j of all<Job>("SELECT * FROM jobs WHERE worker = ? AND status IN ('DOWNLOADING','TRANSCRIBING','ANALYZING')", worker)) {
    updateJob(j.id, { status: "QUEUED", detail: "worker reiniciou; voltou para a fila" });
  }
  for (const c of all<Clip>("SELECT * FROM clips WHERE worker = ? AND status = 'RENDERING'", worker)) {
    updateClip(c.id, { status: "RENDER_QUEUED", detail: "worker reiniciou" });
  }
  return { ok: true };
}, "worker");

route("POST", "/api/worker/heartbeat", (req, _r, _p, body: { task?: string }) => {
  heartbeat(workerOf(req), body?.task ?? "");
  return { ok: true };
}, "worker");

/** Re-render primeiro (alguém está esperando no Estúdio), depois vídeos novos. */
/**
 * Vídeo final sob demanda: o PC guarda o mp4 de cada corte; o hub recebe os que serão publicados
 * dentro da janela de finalWindowH() — com disco folgado, uma semana de agenda, para o PC poder ficar
 * desligado por dias sem atrasar postagens.
 */
const finalRequested = new Map<number, number>(); // clipId → quando foi pedido (evita pedir em dobro)

export const hasFinal = (c: Clip) => existsSync(clipPath(c.job_id, c.id, "mp4"));

function nextFinalNeeded(): Clip | undefined {
  const until = new Date(Date.now() + finalWindowH() * 3600_000).toISOString();
  const due = all<Clip>(
    `SELECT * FROM clips WHERE status IN ('SCHEDULED','PUBLISHING','PUBLISH_FAILED') AND (scheduled_at IS NULL OR scheduled_at <= ?)
     ORDER BY scheduled_at`,
    until,
  );
  return due.find((c) => !hasFinal(c) && Date.now() - (finalRequested.get(c.id) ?? 0) > 15 * 60_000);
}

route("POST", "/api/worker/claim", (req) => {
  const worker = workerOf(req);
  heartbeat(worker);
  // Primeiro: vídeos finais de cortes que saem em breve (sem eles a publicação espera).
  const final = nextFinalNeeded();
  if (final) {
    finalRequested.set(final.id, Date.now());
    const job = getJob(final.job_id)!;
    return { type: "final", clip: final, job, channel: getChannel(job.channel_id), spec: specFor(final) };
  }
  // Disco crítico: não aceita trabalho que gera arquivos novos no hub.
  if (diskState().critical) return { type: "idle", reason: "disco do hub cheio" };
  const clip = get<Clip>("SELECT * FROM clips WHERE status = 'RENDER_QUEUED' ORDER BY id LIMIT 1");
  if (clip) {
    updateClip(clip.id, { status: "RENDERING", worker, error: "", detail: "" });
    const job = getJob(clip.job_id)!;
    return { type: "clip", clip: getClip(clip.id), job, channel: getChannel(job.channel_id), spec: specFor(clip) };
  }
  const job = get<Job>("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY id LIMIT 1");
  if (job) {
    updateJob(job.id, { status: "DOWNLOADING", worker, error: "", detail: "" });
    const hasClips = !!get("SELECT 1 FROM clips WHERE job_id = ?", job.id);
    return { type: "job", job: getJob(job.id), channel: getChannel(job.channel_id), hasClips, template: templateOf(job.template_id, job.channel_id).tpl ?? null };
  }
  return { type: "idle" };
}, "worker");

const JOB_FIELDS = ["status", "detail", "error", "video_url", "video_id", "title", "uploader", "duration", "model", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write", "cost_usd"] as const;

route("POST", "/api/worker/jobs/:id", (req, _r, [id], body: Record<string, string | number>) => {
  const job = must(getJob(+id), "Job");
  heartbeat(workerOf(req), `job #${id}: ${body.status ?? job.status} ${body.detail ?? ""}`.trim());
  const f: Record<string, string | number> = {};
  for (const k of JOB_FIELDS) if (body[k] !== undefined) f[k] = body[k];
  updateJob(job.id, f);
  if (f.status === "FAILED") void tg.jobFailed(getJob(job.id)!);
  if (f.status === "RENDERING") finishJobIfRendered(job.id);
  return { ok: true };
}, "worker");

/** Grava o corpo da requisição em arquivo (escrita atômica: .part → rename). */
async function receiveFile(req: IncomingMessage, dest: string) {
  const tmp = `${dest}.part`;
  await pipeline(req, createWriteStream(tmp));
  renameSync(tmp, dest);
}

route("PUT", "/api/worker/jobs/:id/transcript", async (req, _r, [id]) => {
  must(getJob(+id), "Job");
  await receiveFile(req, transcriptPath(+id));
  return { ok: true };
}, "worker");

route("GET", "/api/worker/jobs/:id/transcript", (req, res, [id]) => {
  serveFile(req, res, transcriptPath(+id));
}, "worker");

route("POST", "/api/worker/jobs/:id/clips", (_q, _r, [id], body: {
  cuts: CutProposal[];
}) => {
  const job = must(getJob(+id), "Job");
  const ch = getChannel(job.channel_id)!;
  const aspect = templateOf(job.template_id, ch.id).tpl?.aspect ?? "9:16";
  if (get("SELECT 1 FROM clips WHERE job_id = ?", job.id)) throw new HttpError(409, "Job já tem cortes");
  body.cuts.forEach((c, i) =>
    run(
      `INSERT INTO clips (job_id, idx, start_s, end_s, score, hook, title, caption, keywords, layout, zoom, aspect, teaser_start, teaser_end, speaker_name, speaker_role, pillar, hashtags)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      job.id, i + 1, c.start_s, c.end_s, c.score, c.hook, c.title,
      renderCaption(ch.caption_template, job, c.title, c.start_s, { pillar: c.pillar, hashtags: c.hashtags }),
      JSON.stringify(c.keywords), c.layout, c.zoom ? 1 : 0, aspect,
      c.teaser_start ?? 0, c.teaser_end ?? 0, c.speaker_name ?? "", c.speaker_role ?? "", c.pillar ?? "", c.hashtags ?? "",
    ),
  );
  updateJob(job.id, body.cuts.length ? { status: "RENDERING", detail: "" } : { status: "DONE", detail: "IA não encontrou trechos com potencial" });
  bus.emit("change", { table: "clips" });
  return { ok: true };
}, "worker");

route("POST", "/api/worker/clips/:id", (req, _r, [id], body: { detail?: string; status?: string; error?: string }) => {
  const clip = must(getClip(+id), "Corte");
  heartbeat(workerOf(req), `corte #${id}: ${body.detail ?? ""}`.trim());
  const f: Record<string, string> = {};
  if (body.detail !== undefined) f.detail = body.detail;
  if (body.status === "FAILED") {
    f.status = "FAILED";
    f.error = body.error ?? "falha no render";
  }
  updateClip(clip.id, f);
  if (f.status) finishJobIfRendered(clip.job_id);
  return { ok: true };
}, "worker");

route("PUT", "/api/worker/clips/:id/files/:kind", async (req, _r, [id, kind]) => {
  const clip = must(getClip(+id), "Corte");
  if (!["mp4", "jpg", "proxy", "preview"].includes(kind)) throw new HttpError(400, "Tipo inválido");
  await receiveFile(req, clipPath(clip.job_id, clip.id, kind as ClipFile));
  return { ok: true };
}, "worker");

route("POST", "/api/worker/clips/:id/done", (_q, _r, [id], body: { layout_used: string; proxy_start: number; proxy_end: number }) => {
  const clip = must(getClip(+id), "Corte");
  // O mp4 final fica no PC; para revisão basta a prévia (Telegram e Estúdio).
  if (!existsSync(clipPath(clip.job_id, clip.id, "preview")) && !hasFinal(clip)) throw new HttpError(409, "prévia não recebida");
  // Já aprovado (re-render de qualidade): volta direto para a agenda, sem pedir revisão de novo.
  const approved = !!clip.approved_at;
  updateClip(clip.id, {
    status: approved ? "SCHEDULED" : "PENDING_REVIEW", layout_used: body.layout_used, proxy_start: body.proxy_start, proxy_end: body.proxy_end,
    rendered_at: new Date().toISOString(), detail: "", error: "",
  });
  if (approved) rebalance(getJob(clip.job_id)!.channel_id);
  else void tg.reviewReady(clip.id);
  finishJobIfRendered(clip.job_id);
  return { ok: true };
}, "worker");

/** Worker terminou (ou falhou) de enviar o vídeo final pedido. */
route("POST", "/api/worker/clips/:id/final", (_q, _r, [id], body: { error?: string }) => {
  const clip = must(getClip(+id), "Corte");
  finalRequested.delete(clip.id);
  if (body?.error) {
    console.error(`[final] corte #${clip.id}: ${body.error}`);
    finalRequested.set(clip.id, Date.now()); // espera 15 min antes de pedir de novo
  }
  bus.emit("change", { table: "clips", id: clip.id });
  return { ok: true, hasFinal: hasFinal(clip) };
}, "worker");

export function finishJobIfRendered(jobId: number) {
  const busy = get("SELECT 1 FROM clips WHERE job_id = ? AND status IN ('RENDER_QUEUED','RENDERING')", jobId);
  const job = getJob(jobId);
  if (!busy && job?.status === "RENDERING") {
    updateJob(jobId, { status: "DONE", detail: "" });
    const n = all("SELECT 1 FROM clips WHERE job_id = ? AND status = 'PENDING_REVIEW'", jobId).length;
    if (n) void tg.jobDone(job, n);
  }
}

/** Worker sumiu (PC desligado/travou): devolve as tarefas dele para a fila. */
export function startReaper() {
  setInterval(() => {
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const dead = new Set(all<{ name: string }>("SELECT name FROM workers WHERE last_seen < ?", cutoff).map((w) => w.name));
    for (const j of all<Job>("SELECT * FROM jobs WHERE status IN ('DOWNLOADING','TRANSCRIBING','ANALYZING')")) {
      if (dead.has(j.worker) || !get("SELECT 1 FROM workers WHERE name = ?", j.worker)) updateJob(j.id, { status: "QUEUED", detail: "worker caiu; voltou para a fila" });
    }
    for (const c of all<Clip>("SELECT * FROM clips WHERE status = 'RENDERING'")) {
      if (dead.has(c.worker) || !get("SELECT 1 FROM workers WHERE name = ?", c.worker)) updateClip(c.id, { status: "RENDER_QUEUED", detail: "worker caiu" });
    }
  }, 60_000);
}
