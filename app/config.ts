import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

const env = (key: string, fallback: string) => process.env[key] || fallback;
const num = (key: string, fallback: number) => Number(process.env[key] || fallback);

const DATA_DIR = resolve(ROOT, env("DATA_DIR", "data"));

/**
 * hub    → banco, dashboard, aprovação, agenda e publicação (máquina 24h)
 * worker → download, transcrição, IA e render (máquina com CPU/GPU)
 * all    → os dois no mesmo processo (instalação única)
 */
export type Role = "hub" | "worker" | "all";
const role = env("ROLE", "all") as Role;
const port = num("PORT", 8080);

export const config = {
  role,
  root: ROOT,
  dataDir: DATA_DIR,
  mediaDir: resolve(DATA_DIR, "media"), // arquivos do hub (cortes finais, proxies, transcrições)
  workDir: resolve(DATA_DIR, "work"), // arquivos do worker (fonte, áudio, renders antes do upload)
  dbPath: resolve(DATA_DIR, "cortes.db"),
  webDir: resolve(ROOT, "web"),

  host: env("HOST", "0.0.0.0"),
  port,
  dashboardUser: env("DASHBOARD_USER", "admin"),
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
  timezone: env("TZ", "America/Sao_Paulo"),
  /** Dias para manter mp4/proxy de cortes publicados no hub (disco do notebook é curto). */
  retentionDays: num("RETENTION_DAYS", 14),

  // Comunicação worker ↔ hub. Em ROLE=all o token é gerado na hora.
  hubUrl: env("HUB_URL", `http://127.0.0.1:${port}`).replace(/\/$/, ""),
  workerToken: process.env.WORKER_TOKEN || (role === "all" ? randomBytes(24).toString("hex") : ""),
  workerName: env("WORKER_NAME", process.env.COMPUTERNAME || process.env.HOSTNAME || "worker"),

  bin: {
    ffmpeg: env("FFMPEG_BIN", "ffmpeg"),
    ffprobe: env("FFPROBE_BIN", "ffprobe"),
    ytdlp: env("YTDLP_BIN", "yt-dlp"),
    whisper: env("WHISPER_BIN", "whisper-cli"),
  },
  whisperModel: resolve(ROOT, env("WHISPER_MODEL", "models/ggml-large-v3-turbo-q5_0.bin")),
  whisperThreads: num("WHISPER_THREADS", 8),
  whisperLanguage: env("WHISPER_LANGUAGE", "pt"),

  faceModel: resolve(ROOT, env("FACE_MODEL", "face_detection_yunet_2023mar.onnx")),

  render: {
    vcodec: env("FFMPEG_VCODEC", "libx264"),
    preset: env("FFMPEG_PRESET", "veryfast"),
    crf: env("FFMPEG_CRF", "21"),
    fps: num("RENDER_FPS", 30),
    font: env("SUBTITLE_FONT", "Montserrat ExtraBold"),
    fontsDir: process.env.SUBTITLE_FONTS_DIR ?? "",
  },

  // Modelo padrão quando o canal não define o seu.
  defaultModel: env("CLAUDE_MODEL", "claude-opus-5-5"),
  defaultEffort: env("CLAUDE_EFFORT", "medium") as Effort,

  // URL pública, Telegram e chaves de YouTube/TikTok: ver hub/settings.ts (dashboard, com .env como fallback).
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// USD por 1M tokens. cacheWrite = escrita de cache com TTL de 5 min (1.25x input).
export const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
