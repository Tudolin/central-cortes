import { mkdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";
import { bus } from "./events.ts";

mkdirSync(config.mediaDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);
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
CREATE INDEX IF NOT EXISTS clips_status ON clips(status);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
`);

export type JobStatus = "QUEUED" | "DOWNLOADING" | "TRANSCRIBING" | "ANALYZING" | "RENDERING" | "DONE" | "FAILED";
export type ClipStatus = "RENDER_QUEUED" | "RENDERING" | "PENDING_REVIEW" | "PUBLISHED" | "REJECTED" | "FAILED";
export type Layout = "single_speaker" | "split_screen" | "screen_share_focus";

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
  rendered_at: string | null;
  published_at: string | null;
  updated_at: string;
}

export const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as T[];
export const get = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as unknown as T | undefined;
export const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

/** UPDATE parcial com whitelist implícita: só colunas passadas em `fields`. */
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
