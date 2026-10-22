import { open, stat } from "node:fs/promises";
import { settings } from "../settings.ts";
import { credentialsOf, getChannel, setCredentials, type Channel, type Clip } from "../../db.ts";

const API = "https://open.tiktokapis.com/v2";
export const tiktokRedirect = () => `${settings.publicUrl}/oauth/tiktok/callback`;

// inbox  = envia como rascunho para a caixa de entrada do app (escopo video.upload, funciona sem auditoria)
// direct = publica direto (escopo video.publish; sem auditoria do app só aceita SELF_ONLY)
const scopeFor = (mode: string) => (mode === "direct" ? "user.info.basic,video.publish" : "user.info.basic,video.upload");

export function tiktokAuthUrl(ch: Channel, state: string): string {
  const q = new URLSearchParams({
    client_key: settings.tiktok.clientKey,
    response_type: "code",
    scope: scopeFor(ch.tiktok_mode),
    redirect_uri: tiktokRedirect(),
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<Required<Pick<TokenResponse, "access_token" | "refresh_token" | "expires_in">> & TokenResponse> {
  const r = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: settings.tiktok.clientKey, client_secret: settings.tiktok.clientSecret, ...params }),
  });
  const t = (await r.json()) as TokenResponse;
  if (!t.access_token || !t.refresh_token) throw new Error(`TikTok OAuth: ${t.error_description || t.error || r.status}`);
  return t as any;
}

function saveTokens(channelId: string, t: TokenResponse & { access_token: string; refresh_token: string; expires_in: number }) {
  setCredentials(channelId, {
    tiktok_access_token: t.access_token,
    tiktok_refresh_token: t.refresh_token, // o TikTok pode rotacionar o refresh token
    tiktok_expires_at: String(Date.now() + t.expires_in * 1000),
    ...(t.scope ? { tiktok_scope: t.scope } : {}),
  });
}

async function api<T>(path: string, token: string, body?: unknown, method = "POST"): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { data: T; error?: { code: string; message: string; log_id?: string } };
  if (!r.ok || (data.error && data.error.code !== "ok")) {
    throw new Error(`TikTok ${path}: ${data.error?.code ?? r.status} ${data.error?.message ?? ""}`.trim());
  }
  return data.data;
}

export async function tiktokConnect(channelId: string, code: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: tiktokRedirect() });
  saveTokens(channelId, t);
  const info = await api<{ user: { display_name: string } }>("/user/info/?fields=display_name", t.access_token, undefined, "GET").catch(() => null);
  setCredentials(channelId, { tiktok_account: info?.user.display_name ?? "conectado" });
}

async function accessToken(ch: Channel): Promise<string> {
  const c = credentialsOf(ch);
  if (!c.tiktok_refresh_token) throw new Error("TikTok não conectado neste canal");
  if (c.tiktok_access_token && Number(c.tiktok_expires_at) > Date.now() + 5 * 60_000) return c.tiktok_access_token;
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.tiktok_refresh_token });
  saveTokens(ch.id, t);
  return t.access_token;
}

/** Regras do Media Transfer Guide: chunks de 5–64 MB, o último absorve o resto (até 128 MB). */
function chunking(size: number) {
  const MB = 1024 * 1024;
  if (size <= 64 * MB) return { chunk: size, count: 1 };
  const chunk = 32 * MB;
  return { chunk, count: Math.floor(size / chunk) };
}

async function uploadFile(uploadUrl: string, file: string, size: number, chunk: number, count: number) {
  const fh = await open(file, "r");
  try {
    for (let i = 0; i < count; i++) {
      const start = i * chunk;
      const end = i === count - 1 ? size - 1 : start + chunk - 1;
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      const r = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": "video/mp4", "content-length": String(buf.length), "content-range": `bytes ${start}-${end}/${size}` },
        body: buf,
      });
      if (!r.ok) throw new Error(`TikTok upload chunk ${i + 1}/${count}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
  } finally {
    await fh.close();
  }
}

/** O que o usuário escolheu na aprovação (diretrizes de Direct Post: nada vem pré-selecionado). */
export interface TikTokPostSettings {
  title: string;
  privacy_level: string;
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  brand_organic: boolean; // "Sua marca"
  brand_content: boolean; // "Conteúdo de marca" (parceria paga)
  consent_at: string;
}

export interface CreatorInfo {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

/** Consultado a cada renderização do painel de publicação e de novo antes de cada post. */
export async function tiktokCreatorInfo(ch: Channel): Promise<CreatorInfo> {
  return api<CreatorInfo>("/post/publish/creator_info/query/", await accessToken(ch), {});
}

const CAN_NOT_POST: Record<string, string> = {
  spam_risk_too_many_posts: "A conta atingiu o limite diário de posts do TikTok. Tente mais tarde.",
  spam_risk_user_banned_from_posting: "Esta conta está impedida de publicar no momento.",
  reached_active_user_cap: "O app atingiu a cota diária de usuários publicando. Tente mais tarde.",
};
export const explainTikTokError = (msg: string) => Object.entries(CAN_NOT_POST).find(([code]) => msg.includes(code))?.[1] ?? msg;

/** Valida as escolhas contra o estado atual da conta (privacidade disponível, interações, duração). */
export function validateTikTokSettings(s: TikTokPostSettings | null, info: CreatorInfo, durationSec: number): string | null {
  if (!s) return "Escolha as opções de publicação do TikTok antes de aprovar.";
  if (!info.privacy_level_options.includes(s.privacy_level)) return "Escolha quem pode ver o vídeo no TikTok.";
  if (s.brand_content && s.privacy_level === "SELF_ONLY") return "Conteúdo de marca não pode ser privado.";
  if ((s.allow_comment && info.comment_disabled) || (s.allow_duet && info.duet_disabled) || (s.allow_stitch && info.stitch_disabled)) {
    return "Uma interação escolhida está desativada nas configurações da conta do TikTok.";
  }
  if (info.max_video_post_duration_sec && durationSec > info.max_video_post_duration_sec) {
    return `O corte tem ${Math.round(durationSec)} s; esta conta aceita até ${info.max_video_post_duration_sec} s.`;
  }
  if (!s.title.trim()) return "A legenda do TikTok está vazia.";
  return null;
}

/** Acompanha o processamento até o post ficar público (ou falhar), por até ~2 min. */
async function waitPublished(token: string, publishId: string, username: string) {
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await api<{ status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(
      "/post/publish/status/fetch/", token, { publish_id: publishId },
    );
    if (st.status === "FAILED") throw new Error(`TikTok recusou o post: ${st.fail_reason ?? "sem motivo"}`);
    if (st.status === "PUBLISH_COMPLETE") {
      const id = st.publicaly_available_post_id?.[0];
      return id ? `https://www.tiktok.com/@${username}/video/${id}` : "";
    }
  }
  return ""; // ainda processando: o TikTok termina sozinho
}

export async function tiktokUpload(ch: Channel, clip: Clip, file: string) {
  const token = await accessToken(ch);
  const fresh = getChannel(ch.id)!;
  const size = (await stat(file)).size;
  const { chunk, count } = chunking(size);
  const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: count };

  if (fresh.tiktok_mode === "direct") {
    const settings = clip.tiktok_settings ? (JSON.parse(clip.tiktok_settings) as TikTokPostSettings) : null;
    let info: CreatorInfo;
    try {
      info = await tiktokCreatorInfo(fresh);
    } catch (e) {
      throw new Error(explainTikTokError((e as Error).message));
    }
    const invalid = validateTikTokSettings(settings, info, clip.end_s - clip.start_s);
    if (invalid) throw new Error(invalid);
    const s = settings!;
    const init = await api<{ publish_id: string; upload_url: string }>("/post/publish/video/init/", token, {
      post_info: {
        title: s.title.slice(0, 2200),
        privacy_level: s.privacy_level,
        disable_comment: !s.allow_comment,
        disable_duet: !s.allow_duet,
        disable_stitch: !s.allow_stitch,
        brand_organic_toggle: s.brand_organic,
        brand_content_toggle: s.brand_content,
        video_cover_timestamp_ms: 1500, // quadro com a faixa de título
      },
      source_info,
    }).catch((e: Error) => {
      throw new Error(explainTikTokError(e.message));
    });
    await uploadFile(init.upload_url, file, size, chunk, count);
    const url = await waitPublished(token, init.publish_id, info.creator_username);
    return { status: "OK" as const, external_id: init.publish_id, url };
  }

  const init = await api<{ publish_id: string; upload_url: string }>("/post/publish/inbox/video/init/", token, { source_info });
  await uploadFile(init.upload_url, file, size, chunk, count);
  return { status: "INBOX" as const, external_id: init.publish_id, url: "" };
}
