import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { settings } from "./settings.ts";
import { all, credentialsOf, get, ensureTemplates, getChannel, getTemplate, getClip, getJob, run, setCredentials, updateChannel, updateClip, updateJob, type Channel, type Clip, type Job, type Post } from "../db.ts";
import { bus } from "../events.ts";
import { HttpError, MIME, must, route, serveFile } from "../http.ts";
import { buildResult, renderCaption } from "../pipeline/caption.ts";
import type { Transcript } from "../pipeline/transcribe.ts";
import { clipPath, finalDownloads, jobMediaDir, transcriptPath, wantsDownload } from "./media.ts";
import { explainTikTokError, tiktokAuthUrl, tiktokConnect, tiktokCreatorInfo, tiktokRedirect, type TikTokPostSettings } from "./publish/tiktok.ts";
import { youtubeAuthUrl, youtubeConnect, youtubeRedirect } from "./publish/youtube.ts";
import { approve, needsTikTokChoices, rebalance, reject, tick } from "./schedule.ts";
import { collectMetrics, metricsState } from "./metrics.ts";
import { readSetting, SETTING_KEYS, writeSettings, type SettingKey } from "./settings.ts";
import { chatCandidates, telegramBotInfo, telegramTest, tg } from "./telegram.ts";
import { diskState } from "./disk.ts";
import { removeYoutubeCookies, saveYoutubeCookies, youtubeCookiesSource, youtubeCookies, youtubeLoginOpen, robotAdoptMain, robotLoginCancel, robotLoginFinish, robotLoginStart, robotLogout, robotScreenUrl, robotStatus } from "./publish/tiktokWeb.ts";

const publicChannel = (c: Channel) => {
  const creds = credentialsOf(c);
  return {
    ...c,
    credentials: Object.keys(creds).filter((k) => !/^(youtube|tiktok|instagram)_/.test(k)),
    connections: {
      youtube: creds.youtube_account ?? null,
      tiktok: creds.tiktok_account ?? null,
      // Conta do Instagram: o @ quando a Meta confirmou; só o ID enquanto o token não foi aceito.
      instagram: creds.instagram_account || (creds.instagram_user_id ? `ID ${creds.instagram_user_id}` : null),
    },
    // Detalhes da conta do Instagram (posts de foto). O token nunca volta ao navegador.
    instagram: {
      user_id: creds.instagram_user_id ?? "",
      error: creds.instagram_error ?? "",
      template_feed: creds.instagram_template_feed ?? "",
      template_story: creds.instagram_template_story ?? "",
    },
    robot: robotStatus(c.id),
    ytrobot: robotStatus(c.id, "youtube"),
  };
};

// ---------- Estado / SSE ----------

route("GET", "/api/state", () => {
  const channels = all<Channel>("SELECT * FROM channels ORDER BY created_at").map(publicChannel);
  const jobs = all<Job>("SELECT * FROM jobs ORDER BY id DESC LIMIT 200");
  const clips = all<Clip & { channel_id: string; video_title: string }>(
    `SELECT c.*, j.channel_id, j.title AS video_title FROM clips c JOIN jobs j ON j.id = c.job_id
     WHERE c.status != 'REJECTED' ORDER BY c.id DESC LIMIT 500`,
  );
  const posts = all(`SELECT p.clip_id, p.platform, p.status, p.url, p.error, p.id, p.scheduled_at, p.locked, p.views, p.likes, p.comments, p.shares, p.saves, p.metrics_at,
      (SELECT s.views FROM post_snapshots s WHERE s.post_id = p.id
         AND julianday(s.at) - julianday(c.published_at) BETWEEN 1.5 AND 2.5
       ORDER BY abs(julianday(s.at) - julianday(c.published_at) - 2) LIMIT 1) AS views48
    FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.clip_id IN (SELECT id FROM clips ORDER BY id DESC LIMIT 500)`);
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
  const workers = all("SELECT * FROM workers ORDER BY last_seen DESC");
  const templates = all("SELECT * FROM templates ORDER BY channel_id, position, id");
  const assets = all("SELECT * FROM assets ORDER BY id DESC");
  const integrations = {
    youtube: !!(settings.youtube.clientId && settings.youtube.clientSecret && settings.publicUrl),
    tiktok: !!(settings.tiktok.clientKey && settings.tiktok.clientSecret && settings.publicUrl),
    telegram: !!(settings.telegram.token && settings.telegram.chatId),
    publicUrl: settings.publicUrl,
    timezone: config.timezone,
    robotScreen: robotScreenUrl(),
  };
  return { channels, jobs, clips, posts, costs, daily, workers, templates, assets, integrations, disk: diskState(), metrics: metricsState };
});

// ---------- Integrações (chaves de app e bot), editáveis pelo dashboard ----------

route("GET", "/api/settings", async () => {
  const out: Record<string, { value: string; set: boolean; source: string }> = {};
  for (const [key, meta] of Object.entries(SETTING_KEYS) as [SettingKey, (typeof SETTING_KEYS)[SettingKey]][]) {
    const { value, source } = readSetting(key);
    // Segredos nunca voltam ao navegador: só os 4 últimos caracteres para conferência.
    out[key] = { value: meta.secret ? (value ? `••••${value.slice(-4)}` : "") : value, set: !!value, source };
  }
  const base = settings.publicUrl;
  return {
    values: out,
    redirects: base ? { youtube: youtubeRedirect(), tiktok: tiktokRedirect() } : null,
    telegram: { bot: await telegramBotInfo(), candidates: [...chatCandidates.values()] },
    youtubeDownload: await Promise.race([
      youtubeCookies().then((c) => ({ loggedIn: !!c, uploaded: youtubeCookiesSource() }), (e) => ({ loggedIn: false, error: (e as Error).message })),
      new Promise((r) => setTimeout(() => r({ loggedIn: false, error: "robô não respondeu" }), 8000)),
    ]),
  };
});

route("PUT", "/api/settings", (_q, _r, _p, body: Record<string, string | null>) => {
  const patch: Partial<Record<SettingKey, string | null>> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!(key in SETTING_KEYS)) continue;
    const k = key as SettingKey;
    // Campo secreto em branco = manter o valor atual; null = remover.
    if (SETTING_KEYS[k].secret && value === "") continue;
    if (k === "public_url" && value && !/^https:\/\/[^\s/]+(:\d+)?\/?$/.test(value.trim())) {
      throw new HttpError(400, "URL pública deve ser https://host[:porta], sem caminho");
    }
    patch[k] = value;
  }
  writeSettings(patch);
  return { ok: true };
});

route("POST", "/api/settings/telegram/authorize", (_q, _r, _p, body: { chat_id: string }) => {
  const c = chatCandidates.get(String(body?.chat_id));
  if (!c) throw new HttpError(404, "Chat não encontrado — mande uma mensagem ao bot primeiro");
  writeSettings({ telegram_chat_id: c.id });
  chatCandidates.clear();
  setTimeout(() => void tg.catchUp(), 3000); // depois da mensagem de teste: manda os cortes que já estavam esperando
  return { ok: true };
});

route("POST", "/api/settings/telegram/test", async () => {
  try {
    await telegramTest();
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return { ok: true };
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

route("POST", "/api/jobs", (_q, _r, _p, body: { channel_id: string; source: string; template_id?: number }) => {
  const ch = must(getChannel(body.channel_id), "Canal");
  const tpl = getTemplate(Number(body.template_id) || ch.default_template);
  if (!tpl || tpl.channel_id !== ch.id) throw new HttpError(400, "Modelo de corte inválido para este canal");
  const sources = String(body.source ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!sources.length) throw new HttpError(400, "Informe ao menos uma URL ou caminho de arquivo");
  const ids = sources.map((s) => Number(run("INSERT INTO jobs (channel_id, source, template_id) VALUES (?, ?, ?)", body.channel_id, s, tpl.id).lastInsertRowid));
  bus.emit("change", { table: "jobs" });
  return { ids };
});

route("POST", "/api/jobs/:id/retry", (_q, _r, [id]) => {
  must(getJob(+id), "Job");
  updateJob(+id, { status: "QUEUED", error: "", detail: "" });
  run("UPDATE clips SET status = 'RENDER_QUEUED', error = '' WHERE job_id = ? AND status = 'FAILED'", +id);
  return { ok: true };
});

route("POST", "/api/jobs/:id/reanalyze", (_q, _r, [id]) => {
  must(getJob(+id), "Job");
  run("DELETE FROM clips WHERE job_id = ? AND status NOT IN ('PUBLISHED','SCHEDULED','PUBLISHING')", +id);
  updateJob(+id, { status: "QUEUED", error: "", detail: "" });
  return { ok: true };
});

route("DELETE", "/api/jobs/:id", (_q, _r, [id]) => {
  const job = must(getJob(+id), "Job");
  if (["DOWNLOADING", "TRANSCRIBING", "ANALYZING"].includes(job.status)) throw new HttpError(409, "Job em processamento");
  run("DELETE FROM jobs WHERE id = ?", +id);
  rmSync(jobMediaDir(+id), { recursive: true, force: true });
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
  const path = transcriptPath(clip.job_id);
  if (!existsSync(path)) return { words: [], sentenceBounds: [] };
  const t = JSON.parse(readFileSync(path, "utf8")) as Transcript;
  return {
    words: t.words.filter((w) => w.e > start && w.s < end),
    sentenceBounds: t.sentences.filter((s) => s.e > start && s.s < end).map((s) => [s.s, s.e]),
  };
});

route("PATCH", "/api/clips/:id", (_q, _r, [id], body: Omit<Partial<Clip>, "overrides"> & { keywords?: string[] | string; rerender?: boolean; overrides?: object }) => {
  const clip = must(getClip(+id), "Corte");
  const job = getJob(clip.job_id)!;
  const ch = getChannel(job.channel_id)!;
  const f: Record<string, string | number | null> = {};
  if (body.start_s != null) f.start_s = Math.max(0, Number(body.start_s));
  if (body.end_s != null) f.end_s = Math.min(job.duration || Infinity, Number(body.end_s));
  if (Number(f.start_s ?? clip.start_s) >= Number(f.end_s ?? clip.end_s)) throw new HttpError(400, "Início deve ser antes do fim");
  if (body.title != null) f.title = String(body.title);
  if (body.layout != null) {
    if (!["single_speaker", "split_screen", "screen_share_focus"].includes(body.layout)) throw new HttpError(400, "Layout inválido");
    f.layout = body.layout;
  }
  if (body.zoom != null) f.zoom = body.zoom ? 1 : 0;
  if (body.keywords != null) f.keywords = JSON.stringify(Array.isArray(body.keywords) ? body.keywords : String(body.keywords).split(",").map((s) => s.trim()).filter(Boolean));
  if (body.overrides != null) f.overrides = JSON.stringify(body.overrides);
  if (body.speaker_name != null) f.speaker_name = String(body.speaker_name).slice(0, 60);
  if (body.speaker_role != null) f.speaker_role = String(body.speaker_role).slice(0, 80);
  if (body.caption != null) f.caption = String(body.caption);
  else if (f.title != null || f.start_s != null) {
    f.caption = renderCaption(ch.caption_template, job, String(f.title ?? clip.title), Number(f.start_s ?? clip.start_s), { pillar: clip.pillar, hashtags: clip.hashtags });
  }
  const visual = ["start_s", "end_s", "layout", "zoom", "keywords", "title", "overrides", "speaker_name", "speaker_role"].some((k) => k in f && f[k] !== (clip as any)[k]);
  if ((body.rerender || visual) && !["PUBLISHED", "PUBLISHING"].includes(clip.status)) {
    // Edição muda o conteúdo: precisa de nova aprovação.
    Object.assign(f, { status: "RENDER_QUEUED", error: "", scheduled_at: null, approved_at: null, schedule_locked: 0 });
  }
  updateClip(+id, f);
  if (f.status) {
    if (job.status === "DONE") updateJob(job.id, { status: "RENDERING" });
    if (clip.status === "SCHEDULED") rebalance(ch.id);
  }
  return getClip(+id);
});

route("POST", "/api/clips/:id/approve", async (_q, _r, [id], body?: { when?: string; tiktok?: Omit<TikTokPostSettings, "consent_at"> }) => {
  try {
    return await approve(+id, body?.when, body?.tiktok);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
});

/** Coleta agora as métricas de YouTube e TikTok (o robô leva ~20 s por canal). */
route("POST", "/api/metrics/refresh", async () => {
  const s = await collectMetrics();
  return { at: s.at, errors: s.errors };
});

/** Aprova vários cortes de uma vez, cada um no próximo horário livre (maior score primeiro = horário mais cedo). */
route("POST", "/api/clips/approve-many", async (_q, _r, _p, body?: { ids?: number[] }) => {
  const clips = (body?.ids ?? []).map((id) => getClip(+id)).filter((c) => c?.status === "PENDING_REVIEW") as Clip[];
  clips.sort((a, b) => b.score - a.score);
  const failed: { id: number; error: string }[] = [];
  let approved = 0;
  for (const c of clips) {
    try {
      await approve(c.id);
      approved++;
    } catch (e) {
      failed.push({ id: c.id, error: (e as Error).message });
    }
  }
  return { approved, failed };
});

/** Dados da conta do TikTok para o painel de publicação (consultados ao vivo a cada abertura). */
route("GET", "/api/clips/:id/tiktok", async (_q, _r, [id]) => {
  const clip = must(getClip(+id), "Corte");
  const ch = getChannel(getJob(clip.job_id)!.channel_id)!;
  if (!needsTikTokChoices(ch)) return { required: false };
  const saved = clip.tiktok_settings ? JSON.parse(clip.tiktok_settings) : null;
  try {
    const info = await tiktokCreatorInfo(ch);
    return { required: true, info, saved, duration: clip.end_s - clip.start_s };
  } catch (e) {
    return { required: true, error: explainTikTokError((e as Error).message), saved };
  }
});

/**
 * Post da fila própria de uma plataforma: muda o horário (trava), "now" publica já, null volta ao automático,
 * skip = não postar este corte nessa plataforma.
 */
route("POST", "/api/posts/:id/move", (_q, _r, [id], body: { when?: string | null; skip?: boolean }) => {
  const p = get<Post & { channel_id: string }>(
    "SELECT p.*, j.channel_id FROM posts p JOIN clips c ON c.id = p.clip_id JOIN jobs j ON j.id = c.job_id WHERE p.id = ?", +id,
  );
  if (!p || p.status !== "PLANNED") throw new HttpError(409, "Post não está agendado");
  if (body.skip) run("UPDATE posts SET status = 'SKIPPED', locked = 0 WHERE id = ?", p.id);
  else if (body.when) {
    const at = body.when === "now" ? new Date(Date.now() + 5_000) : new Date(body.when);
    if (Number.isNaN(at.getTime())) throw new HttpError(400, "Horário inválido");
    run("UPDATE posts SET scheduled_at = ?, locked = 1 WHERE id = ?", at.toISOString(), p.id);
  } else run("UPDATE posts SET locked = 0 WHERE id = ?", p.id);
  rebalance(p.channel_id);
  bus.emit("change", { table: "posts" });
  if (body.when === "now") void tick();
  return { ok: true };
});

/** Redistribui os agendados (não travados) do canal nos próximos horários livres. */
route("POST", "/api/channels/:id/rebalance", (_q, _r, [id]) => {
  must(getChannel(id), "Canal");
  rebalance(id);
  bus.emit("change", { table: "clips" });
  return { ok: true };
});

route("POST", "/api/clips/:id/unschedule", (_q, _r, [id]) => {
  const clip = must(getClip(+id), "Corte");
  if (!["SCHEDULED", "PUBLISH_FAILED"].includes(clip.status)) throw new HttpError(409, "Corte não está agendado");
  updateClip(+id, { status: "PENDING_REVIEW", scheduled_at: null, approved_at: null, schedule_locked: 0, publish_attempts: 0, tiktok_settings: null });
  rebalance(getJob(clip.job_id)!.channel_id);
  return { ok: true };
});

route("POST", "/api/clips/:id/reject", (_q, _r, [id]) => {
  must(getClip(+id), "Corte");
  reject(+id);
  return { ok: true };
});

route("POST", "/api/clips/:id/rerender", (_q, _r, [id]) => {
  const clip = must(getClip(+id), "Corte");
  if (["PUBLISHED", "PUBLISHING"].includes(clip.status)) throw new HttpError(409, "Corte já publicado");
  // Re-render sem edição (qualidade, falha): corte aprovado continua aprovado e volta à agenda ao terminar.
  const keepApproval = clip.status === "SCHEDULED" || clip.status === "PUBLISH_FAILED";
  updateClip(+id, { status: "RENDER_QUEUED", error: "", ...(keepApproval ? {} : { approved_at: null, scheduled_at: null }) });
  const job = getJob(clip.job_id)!;
  if (job.status === "DONE") updateJob(job.id, { status: "RENDERING" });
  return { ok: true };
});

// ---------- Canais ----------

const CHANNEL_FIELDS = [
  "name", "niche", "tone", "extra_instructions", "caption_template", "model", "effort", "clips_target",
  "min_duration", "max_duration", "highlight_color", "max_words_per_frame", "webhook_url",
  "schedule_slots", "platform_slots", "publish_targets", "youtube_privacy", "youtube_category", "youtube_recipe", "tiktok_mode", "tiktok_privacy",
  "title_banner", "banner_color", "banner_text_color", "default_template", "title_style",
] as const;

route("POST", "/api/channels", (_q, _r, _p, body: Partial<Channel>) => {
  const id = String(body.id ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!id || !body.name) throw new HttpError(400, "id e nome são obrigatórios");
  if (getChannel(id)) throw new HttpError(409, "Canal já existe");
  const base = getChannel("ideias_em_comum");
  run("INSERT INTO channels (id, name, caption_template) VALUES (?, ?, ?)", id, body.name, body.caption_template ?? "{titulo_corte}\n\n📺 Corte de: {fonte} ({url_com_timestamp})");
  ensureTemplates(id);
  return saveChannel(id, body);
});

route("PUT", "/api/channels/:id", (_q, _r, [id], body: Partial<Channel> & { credentials?: Record<string, string> }) => {
  must(getChannel(id), "Canal");
  return saveChannel(id, body);
});

function saveChannel(id: string, body: Partial<Channel> & { credentials?: unknown }) {
  const f: Record<string, string | number> = {};
  for (const k of CHANNEL_FIELDS) if (body[k] != null) f[k] = body[k] as string | number;
  if (f.publish_targets != null && typeof f.publish_targets !== "string") f.publish_targets = JSON.stringify(f.publish_targets);
  if (f.platform_slots != null && typeof f.platform_slots !== "string") f.platform_slots = JSON.stringify(f.platform_slots);
  // Credenciais extras são write-only: valor vazio remove a chave, ausente mantém.
  if (body.credentials && typeof body.credentials === "object") setCredentials(id, body.credentials as Record<string, string>);
  updateChannel(id, f);
  bus.emit("channel-saved", id);
  return publicChannel(getChannel(id)!);
}

// ---------- YouTube para downloads (sessão da janela principal do robô) ----------

route("POST", "/api/youtube-download/login", async () => {
  try {
    await youtubeLoginOpen();
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  return { ok: true, screen: robotScreenUrl() };
});

route("POST", "/api/youtube-download/cookies", async (req) => {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  try {
    saveYoutubeCookies(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return { ok: true };
});
route("DELETE", "/api/youtube-download/cookies", () => {
  removeYoutubeCookies();
  return { ok: true };
});

route("GET", "/api/worker/youtube-cookies", async (_q, res) => {
  const txt = await youtubeCookies().catch(() => null);
  if (!txt) throw new HttpError(404, "sem conta do YouTube no robô");
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(txt);
}, "worker");

route("POST", "/api/jobs/retry-failed", () => {
  const failed = all<{ id: number }>("SELECT id FROM jobs WHERE status = 'FAILED'");
  for (const { id } of failed) updateJob(id, { status: "QUEUED", error: "", detail: "" });
  bus.emit("change", { table: "jobs" });
  return { retried: failed.length };
});

// ---------- Robô do TikTok: login por canal ----------

const robotAction = (fn: (id: string) => Promise<unknown> | unknown) => async (_q: unknown, _r: unknown, [id]: string[]) => {
  must(getChannel(id), "Canal");
  try {
    await fn(id);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  bus.emit("change", { table: "channels" });
  return { ok: true, robot: robotStatus(id), screen: robotScreenUrl() };
};
route("POST", "/api/channels/:id/robot/login", robotAction(robotLoginStart));
route("POST", "/api/channels/:id/robot/finish", robotAction(async (id) => {
  await robotLoginFinish(id);
  updateChannel(id, { tiktok_mode: "browser" }); // login salvo = canal passa a publicar pelo robô
}));
route("POST", "/api/channels/:id/robot/cancel", robotAction(robotLoginCancel));
route("POST", "/api/channels/:id/robot/adopt-main", robotAction(async (id) => {
  await robotAdoptMain(id);
  updateChannel(id, { tiktok_mode: "browser" });
}));
route("POST", "/api/channels/:id/robot/logout", robotAction(robotLogout));

// Robô do YouTube Studio: mesma tela remota, sessão própria do canal. Com login salvo, o canal passa a postar por ele.
route("POST", "/api/channels/:id/ytrobot/login", robotAction((id) => robotLoginStart(id, "youtube")));
route("POST", "/api/channels/:id/ytrobot/finish", robotAction(async (id) => {
  await robotLoginFinish(id, "youtube");
  updateChannel(id, { youtube_recipe: "studio" });
}));
route("POST", "/api/channels/:id/ytrobot/cancel", robotAction((id) => robotLoginCancel(id, "youtube")));
route("POST", "/api/channels/:id/ytrobot/adopt-main", robotAction(async (id) => {
  await robotAdoptMain(id, "youtube");
  updateChannel(id, { youtube_recipe: "studio" });
}));
route("POST", "/api/channels/:id/ytrobot/logout", robotAction((id) => robotLogout(id, "youtube")));

// ---------- OAuth (YouTube / TikTok) ----------

const pendingStates = new Map<string, { channel: string; platform: string; at: number }>();

function startOAuth(platform: "youtube" | "tiktok") {
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const channelId = new URL(req.url!, "http://x").searchParams.get("channel") ?? "";
    const ch = must(getChannel(channelId), "Canal");
    if (!settings.publicUrl.startsWith("https://")) throw new HttpError(400, "Defina a URL pública (https) em Canais → Contas conectadas");
    const state = randomBytes(16).toString("hex");
    pendingStates.set(state, { channel: ch.id, platform, at: Date.now() });
    const url = platform === "youtube" ? youtubeAuthUrl(state) : tiktokAuthUrl(ch, state);
    res.writeHead(302, { location: url });
    res.end();
  };
}

function finishOAuth(platform: "youtube" | "tiktok") {
  return async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const q = new URL(req.url!, "http://x").searchParams;
    const pending = pendingStates.get(q.get("state") ?? "");
    pendingStates.delete(q.get("state") ?? "");
    let msg = "";
    if (!pending || pending.platform !== platform || Date.now() - pending.at > 15 * 60_000) msg = "Sessão de login expirada ou inválida";
    else if (q.get("error")) msg = `Autorização negada: ${q.get("error_description") ?? q.get("error")}`;
    else {
      try {
        await (platform === "youtube" ? youtubeConnect : tiktokConnect)(pending.channel, q.get("code") ?? "");
        msg = "ok";
      } catch (e) {
        msg = (e as Error).message;
      }
    }
    res.writeHead(302, { location: `/#channels:${encodeURIComponent(platform)}:${encodeURIComponent(msg)}` });
    res.end();
  };
}

route("GET", "/oauth/youtube/start", startOAuth("youtube"));
route("GET", "/oauth/tiktok/start", startOAuth("tiktok"));
route("GET", "/oauth/youtube/callback", finishOAuth("youtube"), "public");
route("GET", "/oauth/tiktok/callback", finishOAuth("tiktok"), "public");

route("POST", "/api/channels/:id/disconnect/:platform", (_q, _r, [id, platform]) => {
  must(getChannel(id), "Canal");
  const keys = platform === "youtube" ? ["youtube_refresh_token", "youtube_account"]
    : platform === "instagram" ? ["instagram_user_id", "instagram_access_token", "instagram_account", "instagram_error", "instagram_rename", "instagram_template_feed", "instagram_template_story"]
    : ["tiktok_access_token", "tiktok_refresh_token", "tiktok_expires_at", "tiktok_scope", "tiktok_account"];
  setCredentials(id, Object.fromEntries(keys.map((k) => [k, null])));
  return { ok: true };
});

// ---------- Mídia ----------

route("GET", "/media/clip/:file", (req, res, [file]) => {
  const m = file.match(/^(\d+)\.(mp4|jpg|proxy\.mp4)$/);
  if (!m) throw new HttpError(404, "Arquivo inválido");
  const clip = must(getClip(+m[1]), "Corte");
  const kind = m[2] === "proxy.mp4" ? "proxy" : (m[2] as "mp4" | "jpg");
  const download = new URL(req.url!, "http://x").searchParams.has("download")
    ? `${clip.title.replace(/[^\p{L}\p{N} ]/gu, "").slice(0, 60).trim() || "corte"}.mp4`
    : undefined;
  // O vídeo final pode estar só no PC (fora da janela de publicação): mostra a prévia 720p no lugar.
  const path = clipPath(clip.job_id, clip.id, kind);
  // Para baixar, só o final serve: pede ao PC e a página tenta de novo sozinha até ele chegar.
  if (download && kind === "mp4" && !existsSync(path)) {
    if (!wantsDownload(clip.id)) finalDownloads.set(clip.id, Date.now());
    res.writeHead(202, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>Preparando vídeo</title>
<body style="font:16px system-ui;padding:32px;max-width:520px">
<h2>Buscando o vídeo no PC…</h2>
<p>O vídeo final do corte #${clip.id} fica guardado no PC. Já pedi para ele enviar. Esta página tenta de novo a cada 15 s e o download começa sozinho quando o vídeo chegar.</p>
<p style="color:#777">Leva de segundos a alguns minutos (mais se o PC precisar renderizar de novo). O PC precisa estar ligado.</p></body>`);
    bus.emit("change", { table: "clips", id: clip.id });
    return;
  }
  const fallback = clipPath(clip.job_id, clip.id, "preview");
  serveFile(req, res, kind === "mp4" && !existsSync(path) && existsSync(fallback) ? fallback : path, download);
});

// ---------- Site público (exigido pelo TikTok: página do app, termos e privacidade) ----------
// Sem autenticação; publicado pelo Tailscale Funnel em https://<host>/central-cortes/.

const LEGAL_PAGES: Record<string, string> = { "": "index.html", terms: "terms.html", privacy: "privacy.html", "style.css": "style.css", "logo.svg": "logo.svg" };

function serveLegal(res: import("node:http").ServerResponse, page: string) {
  const file = LEGAL_PAGES[page];
  if (!file) throw new HttpError(404, "Página não encontrada");
  const ext = file.slice(file.lastIndexOf("."));
  let body = readFileSync(join(config.webDir, "legal", file), "utf8");
  if (ext === ".html") {
    body = body
      .replaceAll("{{CONTACT}}", process.env.LEGAL_CONTACT_EMAIL || "contato@exemplo.com")
      .replaceAll("{{UPDATED}}", "October 22, 2026");
  }
  res.writeHead(200, { "content-type": MIME[ext] ?? "text/plain", "cache-control": "public, max-age=300" });
  res.end(body);
}

route("GET", "/legal/?", (_q, res) => serveLegal(res, ""), "public");
route("GET", "/legal/:page", (_q, res, [page]) => {
  // Verificação de prefixo de URL do TikTok: arquivo "tiktok….txt" baixado do portal e colocado em data/verify/.
  if (/^tiktok[A-Za-z0-9_-]*\.txt$/.test(page)) {
    const file = join(config.dataDir, "verify", page);
    if (!existsSync(file)) throw new HttpError(404, "Arquivo de verificação não encontrado");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return void res.end(readFileSync(file));
  }
  serveLegal(res, page);
}, "public");
