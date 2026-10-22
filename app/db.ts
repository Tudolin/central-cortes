import { mkdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";
import { bus } from "./events.ts";

mkdirSync(config.mediaDir, { recursive: true });

// timeout = busy_timeout: espera um lock concorrente (ex.: consulta manual, backup) em vez de falhar na hora.
export const db = new DatabaseSync(config.dbPath, { timeout: 5000 });
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niche TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  extra_instructions TEXT NOT NULL DEFAULT '',
  caption_template TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  clips_target INTEGER NOT NULL DEFAULT 5,
  min_duration INTEGER NOT NULL DEFAULT 30,
  max_duration INTEGER NOT NULL DEFAULT 90,
  highlight_color TEXT NOT NULL DEFAULT '#FFD700',
  max_words_per_frame INTEGER NOT NULL DEFAULT 3,
  webhook_url TEXT NOT NULL DEFAULT '',
  credentials TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  source TEXT NOT NULL,
  video_url TEXT NOT NULL DEFAULT '',
  video_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  hook TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '[]',
  layout TEXT NOT NULL DEFAULT 'single_speaker',
  zoom INTEGER NOT NULL DEFAULT 1,
  layout_used TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'RENDER_QUEUED',
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  rendered_at TEXT,
  published_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Uma linha por (corte, plataforma): evita republicar onde já deu certo quando outra plataforma falha.
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,             -- OK | INBOX | FAILED
  external_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (clip_id, platform)
);

-- Integrações do hub (chaves de app, bot do Telegram, URL pública) editáveis pelo dashboard.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  name TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT ''
);
`);

/** Migração aditiva: colunas novas em bancos já existentes. */
function addColumns(table: string, defs: Record<string, string>) {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, def] of Object.entries(defs)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
addColumns("channels", {
  schedule_slots: "TEXT NOT NULL DEFAULT '12:00,18:30,21:00'",
  publish_targets: `TEXT NOT NULL DEFAULT '["youtube","tiktok"]'`,
  youtube_privacy: "TEXT NOT NULL DEFAULT 'public'",
  youtube_category: "TEXT NOT NULL DEFAULT '25'",
  tiktok_mode: "TEXT NOT NULL DEFAULT 'inbox'",
  tiktok_privacy: "TEXT NOT NULL DEFAULT 'SELF_ONLY'",
});
addColumns("jobs", { worker: "TEXT NOT NULL DEFAULT ''" });
addColumns("clips", {
  worker: "TEXT NOT NULL DEFAULT ''",
  proxy_start: "REAL NOT NULL DEFAULT 0",
  proxy_end: "REAL NOT NULL DEFAULT 0",
  approved_at: "TEXT",
  scheduled_at: "TEXT",
  schedule_locked: "INTEGER NOT NULL DEFAULT 0",
  publish_attempts: "INTEGER NOT NULL DEFAULT 0",
  tg_message_id: "INTEGER NOT NULL DEFAULT 0",
});
db.exec(`
CREATE INDEX IF NOT EXISTS clips_status ON clips(status);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
`);

export type JobStatus = "QUEUED" | "DOWNLOADING" | "TRANSCRIBING" | "ANALYZING" | "RENDERING" | "DONE" | "FAILED";
export type ClipStatus =
  | "RENDER_QUEUED" | "RENDERING" | "PENDING_REVIEW" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "PUBLISH_FAILED" | "REJECTED" | "FAILED";
export type Layout = "single_speaker" | "split_screen" | "screen_share_focus";
export type Platform = "youtube" | "tiktok";

export interface Channel {
  id: string;
  name: string;
  niche: string;
  tone: string;
  extra_instructions: string;
  caption_template: string;
  model: string;
  effort: string;
  clips_target: number;
  min_duration: number;
  max_duration: number;
  highlight_color: string;
  max_words_per_frame: number;
  webhook_url: string;
  credentials: string;
  schedule_slots: string;
  publish_targets: string;
  youtube_privacy: string;
  youtube_category: string;
  tiktok_mode: string;
  tiktok_privacy: string;
  created_at: string;
}

export interface Job {
  id: number;
  channel_id: string;
  source: string;
  video_url: string;
  video_id: string;
  title: string;
  duration: number;
  status: JobStatus;
  detail: string;
  error: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number;
  worker: string;
  created_at: string;
  updated_at: string;
}

export interface Clip {
  id: number;
  job_id: number;
  idx: number;
  start_s: number;
  end_s: number;
  score: number;
  hook: string;
  title: string;
  caption: string;
  keywords: string;
  layout: Layout;
  zoom: number;
  layout_used: string;
  status: ClipStatus;
  detail: string;
  error: string;
  worker: string;
  proxy_start: number;
  proxy_end: number;
  rendered_at: string | null;
  approved_at: string | null;
  scheduled_at: string | null;
  schedule_locked: number;
  publish_attempts: number;
  tg_message_id: number;
  published_at: string | null;
  updated_at: string;
}

export interface Post {
  id: number;
  clip_id: number;
  platform: Platform;
  status: "OK" | "INBOX" | "FAILED";
  external_id: string;
  url: string;
  error: string;
  attempts: number;
  updated_at: string;
}

export const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as T[];
export const get = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as unknown as T | undefined;
export const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

/** UPDATE parcial: só as colunas passadas em `fields`. Nomes de coluna vêm sempre de código, nunca do cliente. */
function patch(table: "jobs" | "clips" | "channels", id: number | string, fields: Record<string, SQLInputValue>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const stamp = table === "channels" ? "" : ", updated_at = datetime('now')";
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")}${stamp} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
  bus.emit("change", { table, id });
}

export const updateJob = (id: number, fields: Partial<Record<keyof Job, SQLInputValue>>) => patch("jobs", id, fields);
export const updateClip = (id: number, fields: Partial<Record<keyof Clip, SQLInputValue>>) => patch("clips", id, fields);
export const updateChannel = (id: string, fields: Partial<Record<keyof Channel, SQLInputValue>>) => patch("channels", id, fields);

export const getJob = (id: number) => get<Job>("SELECT * FROM jobs WHERE id = ?", id);
export const getClip = (id: number) => get<Clip>("SELECT * FROM clips WHERE id = ?", id);
export const getChannel = (id: string) => get<Channel>("SELECT * FROM channels WHERE id = ?", id);

export const credentialsOf = (ch: Channel) => JSON.parse(ch.credentials || "{}") as Record<string, string>;
export function setCredentials(id: string, patchCreds: Record<string, string | null>) {
  const cur = credentialsOf(getChannel(id)!);
  for (const [k, v] of Object.entries(patchCreds)) {
    if (v) cur[k] = v;
    else delete cur[k];
  }
  updateChannel(id, { credentials: JSON.stringify(cur) });
}

const DEFAULT_TEMPLATE = `🎙️ {titulo_corte}
Corte do canal Ideias em Comum — debates, análises e ideias que a mídia não pauta.

📺 Vídeo completo: {url_video_original}?t={timestamp_segundos}s
🔔 Inscreva-se: youtube.com/@IdeiasemComum
📱 TikTok: tiktok.com/@IdeiasEmComum

#politicabrasileira #esquerda #IdeiasEmComum #cortes #debate #brasil
#cortes #analise #debate #noticias #reforma #trabalhadores`;

if (!get("SELECT 1 FROM channels LIMIT 1")) {
  run(
    `INSERT INTO channels (id, name, niche, tone, caption_template) VALUES (?, ?, ?, ?, ?)`,
    "ideias_em_comum",
    "Ideias em Comum",
    "Política brasileira, debate econômico-social, análises de conjuntura e pautas progressistas/de esquerda.",
    "Analítico, direto, contundente, engajador, focado em teses e ideias que a grande mídia não pauta.",
    DEFAULT_TEMPLATE,
  );
}
