import { openAsBlob, statSync } from "node:fs";
import { settings } from "../settings.ts";
import { credentialsOf, setCredentials, type Channel, type Clip } from "../../db.ts";

const SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
export const youtubeRedirect = () => `${settings.publicUrl}/oauth/youtube/callback`;

export function youtubeAuthUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: settings.youtube.clientId,
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
    body: new URLSearchParams({ client_id: settings.youtube.clientId, client_secret: settings.youtube.clientSecret, ...params }),
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

/** Visualizações, curtidas e comentários dos vídeos do canal (até 50 IDs por chamada). */
export async function youtubeStats(ch: Channel, ids: string[]) {
  const refresh = credentialsOf(ch).youtube_refresh_token;
  if (!refresh) throw new Error("YouTube não conectado neste canal");
  const { access_token } = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
  const out = new Map<string, { views: number; likes: number; comments: number }>();
  for (let i = 0; i < ids.length; i += 50) {
    const q = new URLSearchParams({ part: "statistics", id: ids.slice(i, i + 50).join(","), maxResults: "50" });
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${q}`, { headers: { authorization: `Bearer ${access_token}` } });
    const data = (await r.json()) as { items?: { id: string; statistics: Record<string, string> }[]; error?: { message: string } };
    if (!r.ok) throw new Error(`YouTube stats ${r.status}: ${data.error?.message ?? ""}`);
    for (const it of data.items ?? []) {
      out.set(it.id, { views: +(it.statistics.viewCount ?? 0), likes: +(it.statistics.likeCount ?? 0), comments: +(it.statistics.commentCount ?? 0) });
    }
  }
  return out;
}

/** Upload resumable (2 requisições): metadados → bytes do vídeo. */
export async function youtubeUpload(ch: Channel, clip: Clip, file: string) {
  const refresh = credentialsOf(ch).youtube_refresh_token;
  if (!refresh) throw new Error("YouTube não conectado neste canal");
  const { access_token } = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });

  // Receita "app": o que muda entre os uploads pelo app do celular (com alcance) e os da API (sem):
  // título sem "#Shorts" (vertical curto já vira Short), nome de arquivo e conteúdo alterado declarado.
  const app = ch.youtube_recipe !== "api";
  const base = clip.title.replace(/[<>]/g, "").trim();
  // "app_tags": como o post manual que teve alcance no Última Rep, as 3 primeiras hashtags da legenda vão no título.
  // "phone": arquivo regravado pelo PC + metadados mínimos (sem idioma nem declaração extra), como o app envia.
  const phone = ch.youtube_recipe === "phone";
  const tags = ch.youtube_recipe === "app_tags" || phone ? (clip.caption.match(/#[^\s#]+/g) ?? []).slice(0, 3) : [];
  let title = app || clip.aspect === "16:9" || base.length > 91 ? base.slice(0, 100) : `${base} #Shorts`;
  for (const t of tags) if (title.length + t.length + 1 <= 100) title += " " + t;
  const size = statSync(file).size;
  const fileName = `${base.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/[^\w ,.-]/g, "").trim().slice(0, 80) || "corte"}.mp4`;
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      authorization: `Bearer ${access_token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": "video/mp4",
      ...(phone ? { slug: encodeURIComponent(`${base.replace(/[\\/:*?"|]/g, "").slice(0, 80)}.mp4`) } : app ? { slug: fileName } : {}),
    },
    body: JSON.stringify({
      snippet: {
        title,
        description: clip.caption.replace(/[<>]/g, "").slice(0, 4900),
        categoryId: ch.youtube_category || "22",
        ...(phone ? {} : { defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" }),
      },
      status: { privacyStatus: ch.youtube_privacy || "public", selfDeclaredMadeForKids: false, ...(app && !phone ? { containsSyntheticMedia: false } : {}) },
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
  return { status: "OK" as const, external_id: data.id, url: `https://youtube.com/shorts/${data.id}`, variant: phone ? "phone" : tags.length ? "app_tags" : app ? "app" : "api" };
}
