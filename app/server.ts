import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { all, getChannel, getClip, getJob, run, updateChannel, updateClip, updateJob, type Channel, type Clip, type Job } from "./db.ts";
import { bus } from "./events.ts";
import { buildResult, renderCaption } from "./pipeline/caption.ts";
import { clipFile } from "./pipeline/render.ts";
import { fetchSource, jobDir } from "./pipeline/source.ts";
import { loadTranscript } from "./pipeline/transcribe.ts";
import { kickJobs, kickRender } from "./worker.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], body: any) => unknown;
const routes: { method: string; re: RegExp; fn: Handler }[] = [];
const route = (method: string, path: string, fn: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`), fn });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const must = <T>(v: T | undefined, what: string): T => {
  if (!v) throw new HttpError(404, `${what} não encontrado`);
  return v;
};

const publicChannel = (c: Channel) => ({ ...c, credentials: Object.keys(JSON.parse(c.credentials || "{}")) });

// ---------- Estado / SSE ----------

route("GET", "/api/state", () => {
  const channels = all<Channel>("SELECT * FROM channels ORDER BY created_at").map(publicChannel);
  const jobs = all<Job>("SELECT * FROM jobs ORDER BY id DESC LIMIT 200");
  const clips = all<Clip & { channel_id: string; video_title: string }>(
    `SELECT c.*, j.channel_id, j.title AS video_title FROM clips c JOIN jobs j ON j.id = c.job_id
     WHERE c.status != 'REJECTED' ORDER BY c.id DESC LIMIT 500`,
  );
  const costs = all(
    `SELECT channel_id, COUNT(*) AS jobs, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
            SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write, SUM(cost_usd) AS cost_usd,
            (SELECT COUNT(*) FROM clips c JOIN jobs j2 ON j2.id = c.job_id WHERE j2.channel_id = jobs.channel_id) AS clips
     FROM jobs GROUP BY channel_id`,
  );
  const daily = all(
    `SELECT date(created_at) AS day, SUM(cost_usd) AS cost_usd, SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_write) AS tokens
     FROM jobs WHERE created_at >= date('now', '-30 days') GROUP BY day ORDER BY day`,
  );
  return { channels, jobs, clips, costs, daily };
});

route("GET", "/api/events", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write("retry: 3000\n\n");
  let timer: NodeJS.Timeout | null = null;
  const onChange = () => {
    timer ??= setTimeout(() => {
      timer = null;
      res.write("data: change\n\n");
    }, 400);
  };
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  bus.on("change", onChange);
  req.on("close", () => {
    bus.off("change", onChange);
    clearInterval(ping);
    if (timer) clearTimeout(timer);
  });
  return undefined;
});

// ---------- Jobs ----------

route("POST", "/api/jobs", (_q, _r, _p, body: { channel_id: string; source: string }) => {
  must(getChannel(body.channel_id), "Canal");
  const sources = String(body.source ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!sources.length) throw new HttpError(400, "Informe ao menos uma URL ou caminho de arquivo");
  const ids = sources.map((s) => Number(run("INSERT INTO jobs (channel_id, source) VALUES (?, ?)", body.channel_id, s).lastInsertRowid));
  bus.emit("change", { table: "jobs" });
  kickJobs();
  return { ids };
});

route("POST", "/api/jobs/:id/retry", (_q, _r, [id]) => {
  must(getJob(+id), "Job");
  updateJob(+id, { status: "QUEUED", error: "", detail: "" });
  run("UPDATE clips SET status = 'RENDER_QUEUED', error = '' WHERE job_id = ? AND status = 'FAILED'", +id);
  kickJobs();
  kickRender();
  return { ok: true };
});

route("POST", "/api/jobs/:id/reanalyze", (_q, _r, [id]) => {
  must(getJob(+id), "Job");
  run("DELETE FROM clips WHERE job_id = ? AND status != 'PUBLISHED'", +id);
  updateJob(+id, { status: "QUEUED", error: "", detail: "" });
  kickJobs();
  return { ok: true };
});

route("DELETE", "/api/jobs/:id", (_q, _r, [id]) => {
  const job = must(getJob(+id), "Job");
  if (["DOWNLOADING", "TRANSCRIBING", "ANALYZING"].includes(job.status)) throw new HttpError(409, "Job em processamento");
  run("DELETE FROM jobs WHERE id = ?", +id);
  rmSync(jobDir(+id), { recursive: true, force: true });
  bus.emit("change", { table: "jobs" });
  return { ok: true };
});

route("GET", "/api/jobs/:id/result", (_q, _r, [id]) => {
  const job = must(getJob(+id), "Job");
  const clips = all<Clip>("SELECT * FROM clips WHERE job_id = ? AND status != 'REJECTED' ORDER BY idx", +id);
  return buildResult(getChannel(job.channel_id)!, job, clips);
});

// ---------- Clips (Estúdio) ----------

route("GET", "/api/clips/:id/transcript", (req, _r, [id]) => {
  const clip = must(getClip(+id), "Corte");
  const url = new URL(req.url!, "http://x");
  const start = Number(url.searchParams.get("start") ?? clip.start_s);
  const end = Number(url.searchParams.get("end") ?? clip.end_s);
  const t = loadTranscript(jobDir(clip.job_id));
  const pad = 20;
  return {
    words: t.words.filter((w) => w.e > start - pad && w.s < end + pad),
    sentenceBounds: t.sentences.filter((s) => s.e > start - 120 && s.s < end + 120).map((s) => [s.s, s.e]),
  };
});

route("PATCH", "/api/clips/:id", (_q, _r, [id], body: Partial<Clip> & { keywords?: string[] | string; rerender?: boolean }) => {
  const clip = must(getClip(+id), "Corte");
  const job = getJob(clip.job_id)!;
  const ch = getChannel(job.channel_id)!;
  const f: Record<string, string | number> = {};
  if (body.start_s != null) f.start_s = Math.max(0, Number(body.start_s));
  if (body.end_s != null) f.end_s = Math.min(job.duration || Infinity, Number(body.end_s));
  if ((f.start_s ?? clip.start_s) >= (f.end_s ?? clip.end_s)) throw new HttpError(400, "Início deve ser antes do fim");
  if (body.title != null) f.title = String(body.title);
  if (body.layout != null) f.layout = body.layout;
  if (body.zoom != null) f.zoom = body.zoom ? 1 : 0;
  if (body.keywords != null) f.keywords = JSON.stringify(Array.isArray(body.keywords) ? body.keywords : String(body.keywords).split(",").map((s) => s.trim()).filter(Boolean));
  if (body.caption != null) f.caption = String(body.caption);
  else if (f.title != null || f.start_s != null) {
    f.caption = renderCaption(ch.caption_template, job, String(f.title ?? clip.title), Number(f.start_s ?? clip.start_s));
  }
  const visual = ["start_s", "end_s", "layout", "zoom", "keywords", "title"].some((k) => k in f && f[k] !== (clip as any)[k]);
  if (body.rerender || (visual && clip.status !== "PUBLISHED")) {
    f.status = "RENDER_QUEUED";
    f.error = "";
  }
  updateClip(+id, f);
  if (f.status) {
    if (job.status === "DONE") updateJob(job.id, { status: "RENDERING" });
    kickRender();
  }
  return getClip(+id);
});

route("POST", "/api/clips/:id/approve", async (_q, _r, [id]) => {
  const clip = must(getClip(+id), "Corte");
  if (clip.status !== "PENDING_REVIEW") throw new HttpError(409, "Só cortes renderizados e pendentes podem ser aprovados");
  updateClip(+id, { status: "PUBLISHED", published_at: new Date().toISOString() });
  const job = getJob(clip.job_id)!;
  const ch = getChannel(job.channel_id)!;
  if (ch.webhook_url) {
    const payload = {
      event: "clip.approved",
      channel_id: ch.id,
      video_file_url: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/media/clip/${clip.id}.mp4` : null,
      corte: buildResult(ch, job, [getClip(+id)!]).cortes[0],
    };
    try {
      const r = await fetch(ch.webhook_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      updateClip(+id, { error: `Webhook falhou: ${(e as Error).message}` });
    }
  }
  return { ok: true };
});

route("POST", "/api/clips/:id/unpublish", (_q, _r, [id]) => {
  must(getClip(+id), "Corte");
  updateClip(+id, { status: "PENDING_REVIEW", published_at: null });
  return { ok: true };
});

route("POST", "/api/clips/:id/reject", (_q, _r, [id]) => {
  must(getClip(+id), "Corte");
  updateClip(+id, { status: "REJECTED" });
  return { ok: true };
});

route("POST", "/api/clips/:id/rerender", (_q, _r, [id]) => {
  const clip = must(getClip(+id), "Corte");
  updateClip(+id, { status: "RENDER_QUEUED", error: "" });
  const job = getJob(clip.job_id)!;
  if (job.status === "DONE") updateJob(job.id, { status: "RENDERING" });
  kickRender();
  return { ok: true };
});

// ---------- Canais ----------

const CHANNEL_FIELDS = [
  "name", "niche", "tone", "extra_instructions", "caption_template", "model", "effort", "clips_target",
  "min_duration", "max_duration", "highlight_color", "max_words_per_frame", "webhook_url",
] as const;

route("POST", "/api/channels", (_q, _r, _p, body: Partial<Channel>) => {
  const id = String(body.id ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!id || !body.name) throw new HttpError(400, "id e nome são obrigatórios");
  if (getChannel(id)) throw new HttpError(409, "Canal já existe");
  const base = getChannel("ideias_em_comum");
  run("INSERT INTO channels (id, name, caption_template) VALUES (?, ?, ?)", id, body.name, body.caption_template ?? base?.caption_template ?? "🎙️ {titulo_corte}\n\n📺 {url_com_timestamp}");
  return saveChannel(id, body);
});

route("PUT", "/api/channels/:id", (_q, _r, [id], body: Partial<Channel> & { credentials?: Record<string, string> }) => {
  must(getChannel(id), "Canal");
  return saveChannel(id, body);
});

function saveChannel(id: string, body: Partial<Channel> & { credentials?: unknown }) {
  const f: Record<string, string | number> = {};
  for (const k of CHANNEL_FIELDS) if (body[k] != null) f[k] = body[k] as string | number;
  // Credenciais são write-only: valores vazios removem a chave, ausentes mantêm.
  if (body.credentials && typeof body.credentials === "object") {
    const cur = JSON.parse(getChannel(id)!.credentials || "{}") as Record<string, string>;
    for (const [k, v] of Object.entries(body.credentials as Record<string, string>)) {
      if (v) cur[k] = v;
      else delete cur[k];
    }
    f.credentials = JSON.stringify(cur);
  }
  updateChannel(id, f);
  return publicChannel(getChannel(id)!);
}

// ---------- Mídia (com suporte a Range para o player) ----------

async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, download?: string) {
  if (!existsSync(path)) throw new HttpError(404, "Arquivo não encontrado");
  const size = statSync(path).size;
  const type = MIME[extname(path)] ?? "application/octet-stream";
  const headers: Record<string, string | number> = { "content-type": type, "accept-ranges": "bytes" };
  if (download) headers["content-disposition"] = `attachment; filename="${download}"`;
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? +range[1] : size - +range[2];
    const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(path).pipe(res);
  }
}

route("GET", "/media/source/:id", async (req, res, [id]) => {
  const job = must(getJob(+id), "Job");
  const src = await fetchSource(job.id, job.source, () => {});
  await serveFile(req, res, src.path);
});

route("GET", "/media/clip/:file", async (req, res, [file]) => {
  const m = file.match(/^(\d+)\.(mp4|jpg)$/);
  if (!m) throw new HttpError(404, "Arquivo inválido");
  const clip = must(getClip(+m[1]), "Corte");
  const download = new URL(req.url!, "http://x").searchParams.has("download")
    ? `${clip.title.replace(/[^\p{L}\p{N} ]/gu, "").slice(0, 60).trim() || "corte"}.mp4`
    : undefined;
  await serveFile(req, res, clipFile(jobDir(clip.job_id), clip.id, m[2] as "mp4" | "jpg"), download);
});

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

// ---------- Servidor ----------

function authorized(req: IncomingMessage): boolean {
  if (!config.dashboardPassword) return true;
  const [scheme, value] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Basic" || !value) return false;
  const given = Buffer.from(Buffer.from(value, "base64").toString());
  const expected = Buffer.from(`${config.dashboardUser}:${config.dashboardPassword}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, "Corpo muito grande");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

export function startServer() {
  const server = createServer(async (req, res) => {
    try {
      if (!authorized(req)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="Editor de Cortes"' });
        return res.end();
      }
      const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
      for (const r of routes) {
        const m = req.method === r.method && path.match(r.re);
        if (!m) continue;
        const out = await r.fn(req, res, m.slice(1), await readBody(req));
        if (!res.headersSent && out !== undefined) json(res, out);
        return;
      }
      if (req.method === "GET" && !path.startsWith("/api/")) {
        const file = normalize(join(config.webDir, path === "/" ? "index.html" : path));
        if (file.startsWith(config.webDir) && existsSync(file) && statSync(file).isFile()) {
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          return createReadStream(file).pipe(res);
        }
      }
      throw new HttpError(404, "Rota não encontrada");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, { error: (e as Error).message }, status);
      else res.end();
    }
  });
  server.listen(config.port, config.host, () => console.log(`Dashboard em http://${config.host}:${config.port}`));
  return server;
}
