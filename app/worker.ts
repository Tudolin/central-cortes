import { config } from "./config.ts";
import { all, get, getChannel, getJob, run, updateClip, updateJob, type Clip, type Job } from "./db.ts";
import { bus } from "./events.ts";
import { analyze } from "./pipeline/analyze.ts";
import { renderCaption } from "./pipeline/caption.ts";
import { renderClip } from "./pipeline/render.ts";
import { fetchSource, jobDir } from "./pipeline/source.ts";
import { loadTranscript, transcribe } from "./pipeline/transcribe.ts";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2000);

/** Throttle de progresso: no máximo 1 escrita/s por entidade para não martelar o SQLite/SSE. */
function progress(update: (detail: string) => void) {
  let last = 0;
  return (detail: string) => {
    const now = Date.now();
    if (now - last > 1000) {
      last = now;
      update(detail);
    }
  };
}

async function processJob(job: Job) {
  const ch = getChannel(job.channel_id);
  if (!ch) throw new Error(`Canal ${job.channel_id} não existe`);
  const dir = jobDir(job.id);

  updateJob(job.id, { status: "DOWNLOADING", detail: "", error: "" });
  const src = await fetchSource(job.id, job.source, progress((d) => updateJob(job.id, { detail: d })));
  updateJob(job.id, { video_url: src.videoUrl, video_id: src.videoId, title: src.title, duration: src.duration });

  updateJob(job.id, { status: "TRANSCRIBING", detail: "" });
  const transcript = await transcribe(dir, src.path, progress((d) => updateJob(job.id, { detail: d })));

  // Retry de job que já foi analisado não paga a IA de novo.
  if (!get("SELECT 1 FROM clips WHERE job_id = ?", job.id)) {
    updateJob(job.id, { status: "ANALYZING", detail: `${transcript.words.length} palavras` });
    const { cuts, usage } = await analyze(ch, transcript, src.title);
    updateJob(job.id, { ...usage });
    const fresh = getJob(job.id)!;
    cuts.forEach((c, i) =>
      run(
        `INSERT INTO clips (job_id, idx, start_s, end_s, score, hook, title, caption, keywords, layout, zoom) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        job.id, i + 1, c.start_s, c.end_s, c.score, c.hook, c.title,
        renderCaption(ch.caption_template, fresh, c.title, c.start_s),
        JSON.stringify(c.keywords), c.layout, c.zoom ? 1 : 0,
      ),
    );
    if (!cuts.length) {
      updateJob(job.id, { status: "DONE", detail: "IA não encontrou trechos com potencial" });
      return;
    }
  }
  updateJob(job.id, { status: "RENDERING", detail: "" });
  bus.emit("change", { table: "clips" });
  kickRender();
}

async function processClip(clip: Clip) {
  const job = getJob(clip.job_id)!;
  const ch = getChannel(job.channel_id)!;
  const dir = jobDir(job.id);
  const src = await fetchSource(job.id, job.source, () => {});
  const layout = await renderClip(clip, ch, dir, src.path, loadTranscript(dir), progress((d) => updateClip(clip.id, { detail: d })));
  updateClip(clip.id, { status: "PENDING_REVIEW", layout_used: layout, rendered_at: new Date().toISOString(), detail: "", error: "" });
}

function finishJobIfRendered(jobId: number) {
  const busy = get("SELECT 1 FROM clips WHERE job_id = ? AND status IN ('RENDER_QUEUED','RENDERING')", jobId);
  const job = getJob(jobId);
  if (!busy && job?.status === "RENDERING") updateJob(jobId, { status: "DONE", detail: "" });
}

let jobBusy = false;
async function jobTick() {
  if (jobBusy) return;
  const job = get<Job>("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY id LIMIT 1");
  if (!job) return;
  jobBusy = true;
  try {
    await processJob(job);
  } catch (e) {
    updateJob(job.id, { status: "FAILED", error: errMsg(e) });
  } finally {
    jobBusy = false;
    setImmediate(jobTick);
  }
}

let renderSlots = config.renderConcurrency;
async function renderTick() {
  while (renderSlots > 0) {
    const clip = get<Clip>("SELECT * FROM clips WHERE status = 'RENDER_QUEUED' ORDER BY id LIMIT 1");
    if (!clip) return;
    renderSlots--;
    updateClip(clip.id, { status: "RENDERING", error: "" });
    processClip(clip)
      .catch((e) => updateClip(clip.id, { status: "FAILED", error: errMsg(e) }))
      .finally(() => {
        renderSlots++;
        finishJobIfRendered(clip.job_id);
        setImmediate(renderTick);
      });
  }
}

export const kickJobs = () => void jobTick();
export const kickRender = () => void renderTick();

export function startWorkers() {
  // Recuperação após reinício: etapas interrompidas voltam para a fila (artefatos já gerados ficam em cache).
  run("UPDATE jobs SET status = 'QUEUED' WHERE status IN ('DOWNLOADING','TRANSCRIBING','ANALYZING')");
  run("UPDATE clips SET status = 'RENDER_QUEUED' WHERE status = 'RENDERING'");
  for (const j of all<{ id: number }>("SELECT id FROM jobs WHERE status = 'RENDERING'")) finishJobIfRendered(j.id);
  setInterval(() => {
    kickJobs();
    kickRender();
  }, 3000);
  kickJobs();
  kickRender();
}
