import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, openAsBlob, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "../config.ts";
import { all, db, get, run } from "../db.ts";
import { bus } from "../events.ts";
import { HttpError, must, route, serveFile } from "../http.ts";
import { read, readSetting, settings, SETTING_KEYS, type SettingKey } from "./settings.ts";
import { tgCall, tgDownload, tgEnabled, tgExtensions, type TgMessage } from "./telegram.ts";

/**
 * Posts de foto no Instagram (o antigo ig-agent, agora dentro do hub).
 *
 *   foto + briefing ─► legenda (DeepSeek) ─► moldura (Templated.io) ─► aprovação ─► agenda ─► Graph API
 *      DRAFT                                                            PENDING     SCHEDULED   PUBLISHED
 *
 * Entra pelo painel (aba Instagram) ou pelo bot do Telegram (foto com o briefing na legenda).
 * Legenda por IA e moldura são opcionais: sem as chaves, a legenda é o próprio briefing e a foto vai como está.
 * A conta é uma só para o hub (não é por canal): estes posts não têm relação com os cortes.
 */

export type IgType = "FEED" | "STORIES";
export type IgStatus = "DRAFT" | "PENDING" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "REJECTED";
export interface IgPost {
  id: number;
  media_type: IgType;
  briefing: string;
  caption: string;
  token: string; // nome público e imprevisível da foto (a Meta e o Templated baixam por URL)
  final_url: string; // imagem com moldura; vazio = publica a foto original
  status: IgStatus;
  detail: string;
  error: string;
  scheduled_at: string | null;
  published_at: string | null;
  ig_media_id: string;
  permalink: string;
  attempts: number;
  tg_message_id: number;
  created_at: string;
  updated_at: string;
}

db.exec(`CREATE TABLE IF NOT EXISTS ig_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL DEFAULT 'FEED',
  briefing TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL,
  final_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT,
  published_at TEXT,
  ig_media_id TEXT NOT NULL DEFAULT '',
  permalink TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  tg_message_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const GRAPH = "https://graph.facebook.com/v22.0";
const MAX_PHOTO = 8 * 1024 * 1024; // limite da Meta para imagens
const RETRY_MIN = [5, 20, 60];
const TYPE_LABEL: Record<IgType, string> = { FEED: "Feed", STORIES: "Story" };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

const getPost = (id: number) => get<IgPost>("SELECT * FROM ig_posts WHERE id = ?", id);
function update(id: number, fields: Partial<IgPost>) {
  const keys = Object.keys(fields) as (keyof IgPost)[];
  if (!keys.length) return;
  run(`UPDATE ig_posts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => fields[k] as string | number | null), id);
  bus.emit("change", { table: "ig_posts", id });
}

const photoDir = () => {
  const dir = join(config.mediaDir, "instagram");
  mkdirSync(dir, { recursive: true });
  return dir;
};
const photoPath = (id: number) => join(photoDir(), `${id}.jpg`);

/**
 * Endereço pelo qual a internet alcança o hub. A Meta e o Templated baixam a foto por URL, então precisa ser
 * público de verdade (túnel/Funnel), não só da rede interna. Ordem: data/ig-media-url.txt (escrito pelo
 * deploy/ig-media-tunnel.sh, cuja URL muda a cada reinício) → configuração do painel → URL pública do hub.
 */
function mediaBase() {
  const file = join(config.dataDir, "ig-media-url.txt");
  const fromFile = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return (fromFile || read("instagram_media_url") || settings.publicUrl).replace(/\/$/, "");
}
function publicPhotoUrl(p: IgPost) {
  const base = mediaBase();
  if (!base) throw new Error("Falta o endereço público das fotos (aba Instagram → Configuração).");
  return `${base}/public/ig/${p.token}.jpg`;
}

const templateFor = (type: IgType) => read(type === "FEED" ? "templated_template_feed" : "templated_template_story");
const canPublish = () => !!(read("instagram_user_id") && read("instagram_access_token"));

// ---------- Legenda (DeepSeek) ----------

const captionPrompt = () => `Você é o redator de legendas do Instagram desta marca:
${read("instagram_brand") || "(marca não descrita: use tom neutro, direto e simpático)"}

ESTRUTURA:
1. Linha de gancho (primeira linha, até 8 palavras)
2. Corpo (2 a 4 linhas curtas)
3. Chamada para ação clara no final
4. Bloco de hashtags depois de uma linha em branco, no máximo 5, sempre de nicho

REGRAS:
- Trate o leitor por "você". No máximo 2 emojis, só se fizerem sentido.
- Máximo de 2200 caracteres.
- Nunca invente dados, preços ou promessas que não estejam no briefing.
- Sem clichês de marketing.
- Se faltar informação essencial, não invente: devolva needs_clarification true com UMA pergunta objetiva.

Responda somente com este JSON:
{"caption": "texto completo com as hashtags", "needs_clarification": false, "clarification_question": null}`;

async function generateCaption(briefing: string, previous = "", feedback = "") {
  const user = previous && feedback
    ? `Briefing original:\n${briefing}\n\nLegenda anterior:\n${previous}\n\nAjuste pedido: ${feedback}\n\nReescreva seguindo as regras. Responda em JSON.`
    : `Briefing do post:\n${briefing}\n\nResponda em JSON.`;
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${read("deepseek_api_key")}` },
    body: JSON.stringify({ model: "deepseek-chat", response_format: { type: "json_object" }, messages: [{ role: "system", content: captionPrompt() }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await r.json().catch(() => ({}))) as { choices?: { message: { content: string } }[]; error?: { message: string } };
  if (!r.ok || !data.choices?.length) throw new Error(`DeepSeek: ${data.error?.message ?? `HTTP ${r.status}`}`);
  const out = JSON.parse(data.choices[0].message.content) as { caption?: string; needs_clarification?: boolean; clarification_question?: string | null };
  return { caption: (out.caption ?? "").slice(0, 2200), question: out.needs_clarification ? (out.clarification_question ?? "") : "" };
}

// ---------- Moldura (Templated.io) ----------

/** Renderiza a foto na camada "photo" do modelo e devolve a URL da imagem pronta (hospedada no Templated). */
async function renderTemplate(templateId: string, photoUrl: string) {
  const r = await fetch("https://api.templated.io/v1/render", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${read("templated_api_key")}` },
    body: JSON.stringify({ template: templateId, format: "jpg", layers: { photo: { image_url: photoUrl } } }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await r.json().catch(() => ({}))) as { url?: string; error?: string; message?: string };
  if (!r.ok || !data.url) throw new Error(`Templated: ${data.error ?? data.message ?? `HTTP ${r.status}`}`);
  return data.url;
}

// ---------- Preparação: legenda + moldura, depois vai para aprovação ----------

/** `caption: false` mantém a legenda atual (só refaz a moldura). Nunca lança: o erro fica no post. */
async function prepare(id: number, opts: { caption?: boolean; feedback?: string } = {}) {
  const p = getPost(id);
  if (!p) return;
  try {
    let caption = p.caption;
    let detail = "";
    if (opts.caption !== false) {
      update(id, { status: "DRAFT", detail: "escrevendo a legenda", error: "" });
      if (read("deepseek_api_key") && p.briefing) {
        const r = await generateCaption(p.briefing, opts.feedback ? p.caption : "", opts.feedback);
        if (r.question) detail = `A IA precisa de mais contexto: ${r.question} Complete o briefing e gere de novo, ou escreva a legenda.`;
        else caption = r.caption;
      } else if (!caption) caption = p.briefing; // sem IA: o briefing vira a legenda, para editar à mão
    }
    let finalUrl = "";
    const tpl = templateFor(p.media_type);
    if (tpl && read("templated_api_key")) {
      update(id, { detail: "aplicando a moldura" });
      finalUrl = await renderTemplate(tpl, publicPhotoUrl(p));
    }
    update(id, { caption, final_url: finalUrl, status: "PENDING", detail, error: "" });
    await sendApproval(id);
  } catch (e) {
    update(id, { status: "FAILED", detail: "", error: `Preparação: ${errMsg(e)}` });
    console.error(`[instagram] post #${id}: ${errMsg(e)}`);
  }
}

function createPost(type: IgType, briefing: string) {
  const id = Number(
    run("INSERT INTO ig_posts (media_type, briefing, token) VALUES (?, ?, ?)", type, briefing.trim().slice(0, 4000), randomBytes(16).toString("hex")).lastInsertRowid,
  );
  bus.emit("change", { table: "ig_posts", id });
  return id;
}

/** Datas do post aceitam "agora", um ISO vindo do painel ou texto do Telegram. Vazio/inválido = erro. */
function approve(id: number, when: string) {
  const p = must(getPost(id), "Post");
  if (!["PENDING", "FAILED", "SCHEDULED"].includes(p.status)) throw new HttpError(409, `Post #${id} está em ${p.status} e não pode ser agendado`);
  if (!canPublish()) throw new HttpError(409, "Conecte a conta do Instagram (ID do usuário e token) antes de aprovar");
  if (!p.final_url && !mediaBase()) throw new HttpError(409, "Falta o endereço público das fotos: sem ele o Instagram não consegue baixar a imagem (aba Instagram → Configuração)");
  const at = when === "now" ? new Date() : new Date(when);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, "Data inválida");
  update(id, { status: "SCHEDULED", scheduled_at: at.toISOString(), attempts: 0, error: "", detail: "" });
  void clearCard(p);
  if (when === "now") void tick();
  return getPost(id)!;
}

function reject(id: number) {
  const p = must(getPost(id), "Post");
  if (p.status === "PUBLISHED" || p.status === "PUBLISHING") throw new HttpError(409, "Post já publicado");
  update(id, { status: "REJECTED", scheduled_at: null, detail: "" });
  void clearCard(p);
}

// ---------- Publicação (Instagram Graph API) ----------

async function graph<T>(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams({ ...params, access_token: read("instagram_access_token") });
  const r = await fetch(`${GRAPH}/${path}?${q}`, { method, signal: AbortSignal.timeout(60_000) });
  const data = (await r.json().catch(() => ({}))) as T & { error?: { message: string; code?: number } };
  if (!r.ok || data.error) throw new Error(`Instagram: ${data.error?.message ?? `HTTP ${r.status}`}`);
  return data;
}

async function publish(p: IgPost) {
  const user = read("instagram_user_id");
  const image = p.final_url || publicPhotoUrl(p);
  const container = await graph<{ id: string }>("POST", `${user}/media`,
    p.media_type === "STORIES" ? { media_type: "STORIES", image_url: image } : { image_url: image, caption: p.caption });
  for (let i = 0; ; i++) {
    const { status_code } = await graph<{ status_code: string }>("GET", container.id, { fields: "status_code" });
    if (status_code === "FINISHED") break;
    if (status_code === "ERROR" || status_code === "EXPIRED") throw new Error("Instagram: a Meta não conseguiu processar a imagem (confira se o endereço público das fotos abre de fora da sua rede)");
    if (i >= 20) throw new Error("Instagram: tempo esgotado esperando a Meta processar a imagem");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const media = await graph<{ id: string }>("POST", `${user}/media_publish`, { creation_id: container.id });
  const info = await graph<{ permalink?: string }>("GET", media.id, { fields: "permalink" }).catch(() => ({ permalink: "" }));
  return { id: media.id, permalink: info.permalink ?? "" };
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const due = all<IgPost>("SELECT * FROM ig_posts WHERE status = 'SCHEDULED' AND scheduled_at <= ? ORDER BY scheduled_at", new Date().toISOString());
    for (const p of due) {
      update(p.id, { status: "PUBLISHING", detail: "publicando" });
      try {
        const r = await publish(p);
        update(p.id, { status: "PUBLISHED", published_at: new Date().toISOString(), ig_media_id: r.id, permalink: r.permalink, detail: "", error: "" });
        await notify(`📸 Instagram: post #${p.id} (${TYPE_LABEL[p.media_type]}) publicado${r.permalink ? `\n${r.permalink}` : ""}`);
      } catch (e) {
        const attempts = p.attempts + 1;
        const wait = RETRY_MIN[attempts - 1];
        if (wait) {
          update(p.id, { status: "SCHEDULED", attempts, scheduled_at: new Date(Date.now() + wait * 60_000).toISOString(), error: errMsg(e), detail: `tentativa ${attempts} falhou; nova em ${wait} min` });
        } else {
          update(p.id, { status: "FAILED", attempts, error: errMsg(e), detail: "" });
          await notify(`⚠️ Instagram: post #${p.id} falhou após ${attempts} tentativas.\n${errMsg(e)}\n\nCorrija na aba Instagram do painel e aprove de novo.`);
        }
        console.error(`[instagram] post #${p.id}: ${errMsg(e)}`);
      }
    }
  } finally {
    busy = false;
  }
}

/** Fotos de posts encerrados há mais de 7 dias saem do disco (o registro fica). */
function prune() {
  const old = all<IgPost>("SELECT * FROM ig_posts WHERE status IN ('PUBLISHED', 'REJECTED') AND updated_at < datetime('now', '-7 days')");
  for (const p of old) rmSync(photoPath(p.id), { force: true });
}

// ---------- Token de longa duração: renova sozinho perto do vencimento ----------

const tokenState = { expiresAt: 0, error: "", checkedAt: 0 };

async function checkToken() {
  const token = read("instagram_access_token");
  const app = read("facebook_app_id");
  const secret = read("facebook_app_secret");
  if (!token || !app || !secret) return;
  tokenState.checkedAt = Date.now();
  try {
    const r = await fetch(`https://graph.facebook.com/debug_token?${new URLSearchParams({ input_token: token, access_token: `${app}|${secret}` })}`, { signal: AbortSignal.timeout(30_000) });
    const info = ((await r.json()) as { data?: { expires_at?: number; is_valid?: boolean; error?: { message: string } } }).data;
    if (!info || info.is_valid === false) throw new Error(info?.error?.message ?? "token inválido");
    tokenState.expiresAt = (info.expires_at ?? 0) * 1000; // 0 = não expira
    tokenState.error = "";
    const daysLeft = (tokenState.expiresAt - Date.now()) / 86400_000;
    if (!tokenState.expiresAt || daysLeft > 10) return;
    const ex = await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: app, client_secret: secret, fb_exchange_token: token })}`, { signal: AbortSignal.timeout(30_000) });
    const fresh = (await ex.json()) as { access_token?: string; expires_in?: number; error?: { message: string } };
    if (!fresh.access_token) throw new Error(fresh.error?.message ?? "a Meta não devolveu um token novo");
    run("INSERT INTO settings (key, value) VALUES ('instagram_access_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", fresh.access_token);
    tokenState.expiresAt = fresh.expires_in ? Date.now() + fresh.expires_in * 1000 : 0;
    await notify("✅ Token do Instagram renovado automaticamente.");
  } catch (e) {
    const first = !tokenState.error;
    tokenState.error = errMsg(e);
    console.error(`[instagram] token: ${tokenState.error}`);
    if (first) await notify(`⚠️ Instagram: não consegui validar/renovar o token.\n${tokenState.error}\n\nGere um token novo e salve na aba Instagram do painel.`);
  }
}

// ---------- Telegram ----------

async function notify(text: string) {
  if (!tgEnabled()) return;
  await tgCall("sendMessage", { chat_id: settings.telegram.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }).catch((e: Error) =>
    console.error(`[telegram] ${e.message}`),
  );
}

const approvalKeyboard = (id: number) => ({
  inline_keyboard: [
    [{ text: "🚀 Publicar agora", callback_data: `igp:${id}` }, { text: "🗓 Agendar", callback_data: `igs:${id}` }],
    [{ text: "✏️ Ajustar legenda", callback_data: `ige:${id}` }, { text: "❌ Rejeitar", callback_data: `igr:${id}` }],
  ],
});

/** Card de aprovação: a imagem pronta (ou a foto original) com a legenda e os botões. */
async function sendApproval(id: number) {
  const p = getPost(id);
  if (!p || !tgEnabled()) return;
  try {
    await clearCard(p);
    const fd = new FormData();
    fd.set("chat_id", settings.telegram.chatId);
    fd.set("caption", `📸 Instagram #${p.id} · ${TYPE_LABEL[p.media_type]}${p.detail ? `\n⚠️ ${p.detail}` : ""}\n\n${p.caption}`.slice(0, 1024));
    fd.set("reply_markup", JSON.stringify(approvalKeyboard(p.id)));
    if (p.final_url) fd.set("photo", p.final_url);
    else fd.set("photo", await openAsBlob(photoPath(p.id), { type: "image/jpeg" }), "post.jpg");
    const msg = await tgCall<{ message_id: number }>("sendPhoto", fd);
    update(p.id, { tg_message_id: msg.message_id });
  } catch (e) {
    console.error(`[telegram] instagram #${id}: ${errMsg(e)}`);
  }
}

/** Decisão tomada (no painel ou no bot): o card com botões sai do chat. */
async function clearCard(p: IgPost) {
  if (!p.tg_message_id || !tgEnabled()) return;
  await tgCall("deleteMessage", { chat_id: settings.telegram.chatId, message_id: p.tg_message_id }).catch(() =>
    tgCall("editMessageReplyMarkup", { chat_id: settings.telegram.chatId, message_id: p.tg_message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {}),
  );
  run("UPDATE ig_posts SET tg_message_id = 0 WHERE id = ?", p.id);
}

/**
 * Data escrita no chat, no fuso do servidor (TZ): "agora", "18:30", "hoje 18:30", "amanhã 9h", "25/08 18:30",
 * "25/08/2027 18:30". Sem ano, vale a próxima ocorrência.
 */
export function parseWhen(text: string, now = new Date()): Date | null {
  const t = text.trim().toLowerCase();
  if (/^agora\b/.test(t)) return now;
  const time = t.match(/(\d{1,2})(?::|h)(\d{2})?\s*$/);
  if (!time) return null;
  const [h, mi] = [Number(time[1]), Number(time[2] ?? 0)];
  if (h > 23 || mi > 59) return null;
  const date = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  const out = new Date(now);
  out.setSeconds(0, 0);
  if (date) {
    const year = date[3] ? (date[3].length === 2 ? 2000 + Number(date[3]) : Number(date[3])) : now.getFullYear();
    out.setFullYear(year, Number(date[2]) - 1, Number(date[1]));
    out.setHours(h, mi);
    if (out.getMonth() !== Number(date[2]) - 1) return null; // dia que não existe no mês
    if (!date[3] && out.getTime() < now.getTime()) out.setFullYear(year + 1);
  } else {
    out.setHours(h, mi);
    if (/amanh[ãa]/.test(t)) out.setDate(out.getDate() + 1);
    else if (out.getTime() <= now.getTime() && !/hoje/.test(t)) out.setDate(out.getDate() + 1);
  }
  return out.getTime() < now.getTime() - 60_000 ? null : out;
}

const fmtWhen = (d: Date) => d.toLocaleString("pt-BR", { timeZone: config.timezone, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** O que o bot espera como próxima mensagem de texto: a data do agendamento ou o ajuste da legenda. */
let awaiting: { id: number; mode: "schedule" | "edit" } | null = null;

async function onTelegramMessage(m: TgMessage): Promise<boolean> {
  if (m.photo?.length) {
    const briefing = (m.caption ?? "").trim();
    const id = createPost("FEED", briefing);
    writeFileSync(photoPath(id), await tgDownload(m.photo[m.photo.length - 1].file_id));
    awaiting = null;
    await tgCall("sendMessage", {
      chat_id: settings.telegram.chatId,
      text: `📸 Post #${id} criado${briefing ? "" : " (sem briefing: mande a foto com uma legenda descrevendo o post para a IA escrever o texto)"}. Qual o formato?`,
      reply_markup: { inline_keyboard: [[{ text: "🖼️ Feed", callback_data: `igf:${id}:FEED` }, { text: "📱 Story", callback_data: `igf:${id}:STORIES` }]] },
    });
    return true;
  }
  const text = (m.text ?? "").trim();
  if (text.split(/[\s@]/)[0] === "/novopost") {
    await notify("📸 Envie a foto e escreva na legenda dela o briefing do post (tema, contexto, objetivo).\nEx.: \"Lançamento do prato X, foco no sabor caseiro, objetivo é trazer gente para o almoço.\"");
    return true;
  }
  if (!awaiting || !text || text.startsWith("/")) return false;
  const { id, mode } = awaiting;
  awaiting = null;
  if (mode === "schedule") {
    const at = parseWhen(text);
    if (!at) {
      awaiting = { id, mode };
      await notify("Não entendi a data. Exemplos: agora · 18:30 · amanhã 9h · 25/08 18:30");
      return true;
    }
    approve(id, at.toISOString());
    void tick();
    await notify(`🗓 Post #${id} agendado para ${fmtWhen(at)}.`);
  } else if (read("deepseek_api_key") && getPost(id)?.briefing) {
    await notify("✏️ Reescrevendo a legenda…");
    await prepare(id, { feedback: text });
  } else {
    update(id, { caption: text.slice(0, 2200) }); // sem IA: o texto enviado é a legenda nova
    await sendApproval(id);
  }
  return true;
}

async function onTelegramCallback(action: string, id: number, arg: string | undefined): Promise<string> {
  const p = getPost(id);
  if (!p) return "Post não encontrado";
  if (action === "igf") {
    if (p.status !== "DRAFT") return "Formato já escolhido";
    update(id, { media_type: arg === "STORIES" ? "STORIES" : "FEED" });
    void prepare(id);
    return "Preparando o post…";
  }
  if (action === "igp") {
    approve(id, "now");
    return "Publicando agora…";
  }
  if (action === "igs") {
    awaiting = { id, mode: "schedule" };
    await notify(`🗓 Quando publicar o post #${id}? Responda com a data e a hora.\nEx.: agora · 18:30 · amanhã 9h · 25/08 18:30`);
    return "";
  }
  if (action === "ige") {
    awaiting = { id, mode: "edit" };
    await notify(read("deepseek_api_key") ? `✏️ Diga o que ajustar na legenda do post #${id}.` : `✏️ Envie a legenda nova do post #${id}.`);
    return "";
  }
  if (action === "igr") {
    reject(id);
    return "Rejeitado";
  }
  return "";
}

// ---------- API do painel ----------

const IG_SETTINGS: SettingKey[] = [
  "instagram_user_id", "instagram_access_token", "facebook_app_id", "facebook_app_secret",
  "deepseek_api_key", "instagram_brand", "templated_api_key", "templated_template_feed", "templated_template_story", "instagram_media_url",
];

route("GET", "/api/instagram", () => {
  const values: Record<string, { value: string; set: boolean; source: string }> = {};
  for (const key of IG_SETTINGS) {
    const { value, source } = readSetting(key);
    values[key] = { value: SETTING_KEYS[key].secret ? (value ? `••••${value.slice(-4)}` : "") : value, set: !!value, source };
  }
  return {
    posts: all<IgPost>("SELECT * FROM ig_posts ORDER BY id DESC LIMIT 100").map(({ token: _t, ...p }) => ({ ...p, has_photo: existsSync(photoPath(p.id)) })),
    settings: values,
    status: {
      account: canPublish(),
      ai: !!read("deepseek_api_key"),
      frame: { FEED: !!(read("templated_api_key") && templateFor("FEED")), STORIES: !!(read("templated_api_key") && templateFor("STORIES")) },
      mediaBase: mediaBase(),
      telegram: tgEnabled(),
      token: tokenState,
    },
  };
});

async function receivePhoto(req: IncomingMessage, dest: string) {
  if (Number(req.headers["content-length"] ?? 0) > MAX_PHOTO) throw new HttpError(413, "Foto maior que 8 MB (limite do Instagram)");
  await pipeline(req, createWriteStream(`${dest}.part`));
  renameSync(`${dest}.part`, dest);
}

/** Corpo = o arquivo da foto. O Instagram só aceita JPEG. */
route("POST", "/api/instagram/posts", async (req) => {
  const q = new URL(req.url!, "http://x").searchParams;
  if (!/\.jpe?g$/i.test(q.get("name") ?? "")) throw new HttpError(400, "Envie a foto em JPEG (.jpg): é o único formato que o Instagram aceita");
  const id = createPost(q.get("type") === "STORIES" ? "STORIES" : "FEED", q.get("briefing") ?? "");
  try {
    await receivePhoto(req, photoPath(id));
  } catch (e) {
    run("DELETE FROM ig_posts WHERE id = ?", id);
    rmSync(`${photoPath(id)}.part`, { force: true });
    throw e;
  }
  void prepare(id);
  return { id };
});

const editable = (id: string) => {
  const p = must(getPost(+id), "Post");
  if (p.status === "PUBLISHED" || p.status === "PUBLISHING") throw new HttpError(409, "Post já publicado");
  return p;
};

route("PUT", "/api/instagram/posts/:id", (_q, _r, [id], body: { caption?: string; briefing?: string }) => {
  const p = editable(id);
  const f: Partial<IgPost> = {};
  if (typeof body?.caption === "string") f.caption = body.caption.slice(0, 2200);
  if (typeof body?.briefing === "string") f.briefing = body.briefing.slice(0, 4000);
  update(p.id, f);
  return { ok: true };
});

/** Refaz a legenda pela IA (com um ajuste opcional) e/ou a moldura; `media_type` troca o formato. */
route("POST", "/api/instagram/posts/:id/prepare", (_q, _r, [id], body: { caption?: boolean; feedback?: string; media_type?: IgType }) => {
  const p = editable(id);
  if (!existsSync(photoPath(p.id))) throw new HttpError(409, "A foto deste post já saiu do disco; crie um post novo");
  if (body?.caption !== false && !read("deepseek_api_key")) throw new HttpError(409, "Sem chave do DeepSeek: escreva a legenda à mão ou salve a chave na configuração");
  if (body?.media_type) update(p.id, { media_type: body.media_type === "STORIES" ? "STORIES" : "FEED" });
  update(p.id, { status: "DRAFT", scheduled_at: null });
  void prepare(p.id, { caption: body?.caption, feedback: body?.feedback });
  return { ok: true };
});

route("POST", "/api/instagram/posts/:id/approve", (_q, _r, [id], body: { when?: string }) => {
  const { token: _t, ...p } = approve(+id, body?.when || "now");
  return p;
});
route("POST", "/api/instagram/posts/:id/reject", (_q, _r, [id]) => {
  reject(+id);
  return { ok: true };
});
route("DELETE", "/api/instagram/posts/:id", (_q, _r, [id]) => {
  const p = must(getPost(+id), "Post");
  if (p.status === "PUBLISHING") throw new HttpError(409, "Post sendo publicado agora");
  void clearCard(p);
  rmSync(photoPath(p.id), { force: true });
  run("DELETE FROM ig_posts WHERE id = ?", p.id);
  bus.emit("change", { table: "ig_posts", id: p.id });
  return { ok: true };
});

route("POST", "/api/instagram/token/check", async () => {
  if (!read("facebook_app_id") || !read("facebook_app_secret")) throw new HttpError(409, "Salve o ID e o segredo do app da Meta para conferir e renovar o token");
  tokenState.error = "";
  await checkToken();
  return tokenState;
});

// Foto original para o painel (com senha) e para a Meta/Templated (pública, pelo nome imprevisível).
route("GET", "/media/ig/:id", (req, res, [id]) => serveFile(req, res, photoPath(must(getPost(+id), "Post").id)));
function servePublicPhoto(req: IncomingMessage, res: ServerResponse, file: string) {
  const m = file.match(/^([0-9a-f]{32})\.jpg$/);
  const p = m && get<IgPost>("SELECT * FROM ig_posts WHERE token = ?", m[1]);
  if (!p) throw new HttpError(404, "Arquivo não encontrado");
  serveFile(req, res, photoPath(p.id));
}
route("GET", "/public/ig/:file", (req, res, [file]) => servePublicPhoto(req, res, file), "public");

/**
 * Porta só das fotos (IG_MEDIA_PORT): é para ela que o túnel público aponta, assim o painel e o resto da API
 * nunca ficam expostos à internet. Responde apenas GET /public/ig/<nome>.jpg.
 */
function startMediaServer(port: number) {
  createServer((req, res) => {
    try {
      const m = req.method === "GET" && new URL(req.url!, "http://x").pathname.match(/^\/public\/ig\/([^/]+)$/);
      if (!m) throw new HttpError(404, "Não encontrado");
      servePublicPhoto(req, res, m[1]);
    } catch {
      if (!res.headersSent) res.writeHead(404).end();
    }
  }).listen(port, config.host, () => console.log(`[instagram] fotos públicas na porta ${port}`));
}

tgExtensions.push({ prefix: "ig", message: onTelegramMessage, callback: onTelegramCallback });

export function startInstagram() {
  // Recupera o que um reinício interrompeu: publicação volta para a fila, preparação vira erro visível.
  run("UPDATE ig_posts SET status = 'SCHEDULED' WHERE status = 'PUBLISHING'");
  run("UPDATE ig_posts SET status = 'FAILED', error = 'Preparação interrompida por reinício; gere de novo' WHERE status = 'DRAFT' AND detail != ''");
  setInterval(() => void tick().catch((e) => console.error("[instagram]", e)), 30_000);
  setInterval(prune, 6 * 3600_000);
  setInterval(() => void checkToken(), 24 * 3600_000);
  setTimeout(() => void checkToken(), 60_000);
  const mediaPort = Number(process.env.IG_MEDIA_PORT || 0);
  if (mediaPort) startMediaServer(mediaPort);
  void tick();
}
