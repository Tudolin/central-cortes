import { openAsBlob, statSync } from "node:fs";
import { config } from "../../config.ts";
import { credentialsOf, setCredentials, type Channel, type Clip } from "../../db.ts";

const SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
export const youtubeRedirect = () => `${config.publicUrl}/oauth/youtube/callback`;

export function youtubeAuthUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: config.youtube.clientId,
    redirect_uri: youtubeRedirect(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // garante refresh_token mesmo em reconexão
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.youtube.clientId, client_secret: config.youtube.clientSecret, ...params }),
  });
  const data = (await r.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
  if (!r.ok || !data.access_token) throw new Error(`Google OAuth: ${data.error_description || data.error || r.status}`);
  return data;
}

export async function youtubeConnect(channelId: string, code: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: youtubeRedirect() });
  if (!t.refresh_token) throw new Error("Google não devolveu refresh_token; remova o acesso do app na conta Google e conecte de novo.");
  const me = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { authorization: `Bearer ${t.access_token}` },
  }).then((r) => r.json() as Promise<{ items?: { snippet: { title: string } }[] }>);
  setCredentials(channelId, { youtube_refresh_token: t.refresh_token, youtube_account: me.items?.[0]?.snippet.title ?? "conectado" });
}

/** Upload resumable (2 requisições): metadados → bytes do vídeo. */
export async function youtubeUpload(ch: Channel, clip: Clip, file: string) {
  const refresh = credentialsOf(ch).youtube_refresh_token;
  if (!refresh) throw new Error("YouTube não conectado neste canal");
  const { access_token } = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });

  const base = clip.title.replace(/[<>]/g, "").trim();
  const title = base.length <= 91 ? `${base} #Shorts` : base.slice(0, 100);
  const size = statSync(file).size;
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      authorization: `Bearer ${access_token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: {
        title,
        description: clip.caption.replace(/[<>]/g, "").slice(0, 4900),
        categoryId: ch.youtube_category || "22",
        defaultLanguage: "pt-BR",
        defaultAudioLanguage: "pt-BR",
      },
      status: { privacyStatus: ch.youtube_privacy || "public", selfDeclaredMadeForKids: false },
    }),
  });
  const location = init.headers.get("location");
  if (!init.ok || !location) throw new Error(`YouTube init ${init.status}: ${(await init.text()).slice(0, 400)}`);

  const up = await fetch(location, {
    method: "PUT",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "video/mp4", "content-length": String(size) },
    body: await openAsBlob(file),
  });
  const data = (await up.json().catch(() => ({}))) as { id?: string; error?: { message: string } };
  if (!up.ok || !data.id) throw new Error(`YouTube upload ${up.status}: ${data.error?.message ?? "sem id"}`);
  return { status: "OK" as const, external_id: data.id, url: `https://youtube.com/shorts/${data.id}` };
}
