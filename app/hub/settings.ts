import { get, run } from "../db.ts";
import { bus } from "../events.ts";

/**
 * Integrações configuráveis pelo dashboard. Ordem de leitura: banco → variável de ambiente → vazio.
 * Lidas a cada uso, então mudanças valem na hora, sem reiniciar o hub.
 */
export const SETTING_KEYS = {
  public_url: { env: "PUBLIC_URL", secret: false },
  telegram_bot_token: { env: "TELEGRAM_BOT_TOKEN", secret: true },
  telegram_chat_id: { env: "TELEGRAM_CHAT_ID", secret: false },
  youtube_client_id: { env: "YOUTUBE_CLIENT_ID", secret: false },
  youtube_client_secret: { env: "YOUTUBE_CLIENT_SECRET", secret: true },
  tiktok_client_key: { env: "TIKTOK_CLIENT_KEY", secret: false },
  tiktok_client_secret: { env: "TIKTOK_CLIENT_SECRET", secret: true },
  // Posts de foto no Instagram (hub/instagram.ts). Os nomes do .env são os do antigo ig-agent.
  instagram_user_id: { env: "IG_USER_ID", secret: false },
  instagram_access_token: { env: "IG_ACCESS_TOKEN", secret: true },
  facebook_app_id: { env: "FB_APP_ID", secret: false },
  facebook_app_secret: { env: "FB_APP_SECRET", secret: true },
  templated_api_key: { env: "TEMPLATED_API_KEY", secret: true },
  templated_template_feed: { env: "TEMPLATE_ID_FEED", secret: false },
  templated_template_story: { env: "TEMPLATE_ID_STORY", secret: false },
  deepseek_api_key: { env: "DEEPSEEK_API_KEY", secret: true },
  instagram_brand: { env: "IG_BRAND", secret: false },
  instagram_media_url: { env: "IG_MEDIA_URL", secret: false },
} as const;
export type SettingKey = keyof typeof SETTING_KEYS;

export function readSetting(key: SettingKey): { value: string; source: "dashboard" | "env" | "" } {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  if (row?.value) return { value: row.value, source: "dashboard" };
  const env = process.env[SETTING_KEYS[key].env];
  return env ? { value: env, source: "env" } : { value: "", source: "" };
}

export const read = (key: SettingKey) => readSetting(key).value;

/** null/"" remove (volta para o .env, se houver). */
export function writeSettings(values: Partial<Record<SettingKey, string | null>>) {
  for (const [key, value] of Object.entries(values) as [SettingKey, string | null][]) {
    if (!(key in SETTING_KEYS)) continue;
    const v = (value ?? "").trim();
    if (v) run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, v);
    else run("DELETE FROM settings WHERE key = ?", key);
  }
  bus.emit("change", { table: "settings" });
  bus.emit("settings-saved");
}

export const settings = {
  get publicUrl() {
    return read("public_url").replace(/\/$/, "");
  },
  telegram: {
    get token() {
      return read("telegram_bot_token");
    },
    get chatId() {
      return read("telegram_chat_id");
    },
  },
  youtube: {
    get clientId() {
      return read("youtube_client_id");
    },
    get clientSecret() {
      return read("youtube_client_secret");
    },
  },
  tiktok: {
    get clientKey() {
      return read("tiktok_client_key");
    },
    get clientSecret() {
      return read("tiktok_client_secret");
    },
  },
};
