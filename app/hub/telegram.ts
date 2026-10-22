import { existsSync, openAsBlob, statSync } from "node:fs";
import { config } from "../config.ts";
import { settings } from "./settings.ts";
import { all, get, getChannel, getClip, getJob, updateClip, type Clip, type Job, type Post } from "../db.ts";
import { bus } from "../events.ts";
import { clipPath } from "./media.ts";
import { explainTikTokError, tiktokCreatorInfo, type CreatorInfo } from "./publish/tiktok.ts";
import { approve, needsTikTokChoices, reject } from "./schedule.ts";

/**
 * Bot de aprovação via long polling (não precisa de URL pública nem conflita com o webhook do ig-agent,
 * desde que seja um bot próprio). Só aceita comandos do TELEGRAM_CHAT_ID configurado.
 */
const enabled = () => !!(settings.telegram.token && settings.telegram.chatId);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: config.timezone, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const dur = (c: Clip) => {
  const s = Math.round(c.end_s - c.start_s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const studioLink = (clipId: number) => (settings.publicUrl.startsWith("https://") ? `${settings.publicUrl}/#clip=${clipId}` : "");

async function call<T = any>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const r = await fetch(`https://api.telegram.org/bot${settings.telegram.token}/${method}`, {
    method: "POST",
    ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(method === "getUpdates" ? 70_000 : 120_000),
  });
  const data = (await r.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

function reviewCaption(c: Clip, footer = "") {
  const job = getJob(c.job_id)!;
  const ch = getChannel(job.channel_id)!;
  return (
    `<b>${esc(c.title)}</b>\n⭐ ${c.score} · ${dur(c)} · ${esc(ch.name)}\n💡 ${esc(c.hook)}\n<i>${esc(job.title).slice(0, 120)}</i>` +
    (footer ? `\n\n${footer}` : "")
  ).slice(0, 1024);
}

function reviewKeyboard(clipId: number) {
  const rows: object[][] = [
    [{ text: "✅ Aprovar", callback_data: `ap:${clipId}` }, { text: "❌ Rejeitar", callback_data: `rj:${clipId}` }],
    [{ text: "🚀 Publicar agora", callback_data: `now:${clipId}` }],
  ];
  const link = studioLink(clipId);
  if (link) rows.push([{ text: "✏️ Abrir no Estúdio", url: link }]);
  return { inline_keyboard: rows };
}

async function send(text: string) {
  if (!enabled()) return;
  await call("sendMessage", { chat_id: settings.telegram.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }).catch((e) =>
    console.error(`[telegram] ${e.message}`),
  );
}

const retryAt = new Map<number, number>();

export const tg = {
  /** Corte renderizado: envia o vídeo com botões de decisão. */
  async reviewReady(clipId: number) {
    if (!enabled()) return;
    const c = getClip(clipId);
    if (!c) return;
    try {
      // Prévia 720p leve; o arquivo final (bitrate alto) costuma passar do limite de 50 MB do bot.
      const preview = clipPath(c.job_id, c.id, "preview");
      const mp4 = existsSync(preview) ? preview : clipPath(c.job_id, c.id, "mp4");
      const jpg = clipPath(c.job_id, c.id, "jpg");
      const fd = new FormData();
      fd.set("chat_id", settings.telegram.chatId);
      fd.set("caption", reviewCaption(c));
      fd.set("parse_mode", "HTML");
      fd.set("reply_markup", JSON.stringify(reviewKeyboard(c.id)));
      let method = "sendVideo";
      if (existsSync(mp4) && statSync(mp4).size < 49 * 1024 * 1024) {
        fd.set("video", await openAsBlob(mp4, { type: "video/mp4" }), "corte.mp4");
        fd.set("supports_streaming", "true");
        fd.set("width", "720");
        fd.set("height", "1280");
      } else {
        method = "sendPhoto";
        fd.set("photo", await openAsBlob(jpg, { type: "image/jpeg" }), "corte.jpg");
      }
      // Re-render: apaga a mensagem antiga para não ficar botão órfão.
      if (c.tg_message_id) await call("deleteMessage", { chat_id: settings.telegram.chatId, message_id: c.tg_message_id }).catch(() => {});
      const msg = await call<{ message_id: number }>(method, fd);
      updateClip(c.id, { tg_message_id: msg.message_id });
    } catch (e) {
      console.error(`[telegram] reviewReady ${clipId}: ${(e as Error).message}`);
    }
  },

  /**
   * Envia cortes em revisão que ainda não chegaram ao Telegram: renderizados antes de o chat ser
   * autorizado, ou cujo envio falhou. Falhas esperam 10 min antes de tentar de novo.
   */
  async catchUp() {
    if (!enabled()) return;
    const pending = all<{ id: number }>(
      "SELECT id FROM clips WHERE status = 'PENDING_REVIEW' AND tg_message_id = 0 AND rendered_at IS NOT NULL ORDER BY score DESC, id LIMIT 10",
    );
    for (const { id } of pending) {
      if ((retryAt.get(id) ?? 0) > Date.now()) continue;
      await tg.reviewReady(id);
      if (!getClip(id)?.tg_message_id) retryAt.set(id, Date.now() + 10 * 60_000);
      else retryAt.delete(id);
    }
  },

  /** Decisão tomada (em qualquer lugar): atualiza a mensagem original e tira os botões. */
  async clipDecided(c: Clip, kind: "approved" | "rejected") {
    if (!enabled() || !c.tg_message_id) return;
    const footer = kind === "approved" ? `✅ <b>Aprovado</b> — agendado para ${fmtWhen(c.scheduled_at)}` : "❌ <b>Rejeitado</b>";
    await call("editMessageCaption", {
      chat_id: settings.telegram.chatId,
      message_id: c.tg_message_id,
      caption: reviewCaption(c, footer),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  },

  async published(c: Clip, posts: Post[]) {
    const lines = posts.map((p) =>
      p.platform === "tiktok" && p.status === "INBOX"
        ? "🎵 TikTok: rascunho enviado à caixa de entrada — finalize no app com a legenda abaixo"
        : p.platform === "tiktok" && !p.url
          ? "🎵 TikTok: enviado — pode levar alguns minutos para processar e aparecer no perfil"
          : `${p.platform === "youtube" ? "▶️ YouTube" : "🎵 TikTok"}: ${p.url || "publicado"}`,
    );
    const inbox = posts.some((p) => p.status === "INBOX");
    await send(`📤 <b>${esc(c.title)}</b>\n${lines.join("\n")}${inbox ? `\n\n<code>${esc(c.caption).slice(0, 3500)}</code>` : ""}`);
  },

  async publishFailed(c: Clip, errors: string[]) {
    await send(`⚠️ Falha ao publicar <b>${esc(c.title)}</b> após várias tentativas:\n${esc(errors.join("\n")).slice(0, 3000)}\n\nCorrija no dashboard e aprove de novo.`);
  },

  async jobFailed(j: Job) {
    await send(`⚠️ Job #${j.id} falhou (${esc(j.title || j.source)}):\n<code>${esc(j.error).slice(0, 1500)}</code>`);
  },

  async jobDone(j: Job, clips: number) {
    await send(`🎬 <b>${esc(j.title)}</b>: ${clips} corte(s) prontos para revisão.`);
  },
};

// ---------- Escolhas do TikTok pelo Telegram (publicação direta) ----------
// As diretrizes do TikTok exigem que, a cada post, o usuário escolha a visibilidade (sem padrão) e as
// interações (desmarcadas por padrão) e concorde com a Music Usage Confirmation antes do envio.

const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "👥 Todos",
  MUTUAL_FOLLOW_FRIENDS: "🤝 Amigos",
  FOLLOWER_OF_CREATOR: "👤 Seguidores",
  SELF_ONLY: "🔒 Só eu",
};
const MUSIC_POLICY = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";

interface TikTokDraft {
  when?: string;
  info: CreatorInfo;
  privacy: string | null;
  comment: boolean;
  duet: boolean;
  stitch: boolean;
}
const drafts = new Map<number, TikTokDraft>();

function tiktokKeyboard(id: number, d: TikTokDraft) {
  const nick = `TikTok: ${d.info.creator_nickname} (@${d.info.creator_username})`;
  if (!d.privacy) {
    return {
      inline_keyboard: [
        [{ text: `${nick} — quem pode ver?`, callback_data: "noop" }],
        d.info.privacy_level_options.map((p, i) => ({ text: PRIVACY_LABEL[p] ?? p, callback_data: `tp:${id}:${i}` })),
        [{ text: "↩ Voltar", callback_data: `tb:${id}` }],
      ],
    };
  }
  const toggle = (key: "comment" | "duet" | "stitch", label: string, disabled: boolean) =>
    disabled
      ? { text: `🚫 ${label} (desativado na conta)`, callback_data: "noop" }
      : { text: `${d[key] ? "☑" : "☐"} Permitir ${label.toLowerCase()}`, callback_data: `tc:${id}:${key[0]}` };
  return {
    inline_keyboard: [
      [{ text: `${nick} · ${PRIVACY_LABEL[d.privacy] ?? d.privacy} (trocar)`, callback_data: `tpc:${id}` }],
      [toggle("comment", "Comentários", d.info.comment_disabled)],
      [toggle("duet", "Dueto", d.info.duet_disabled), toggle("stitch", "Stitch", d.info.stitch_disabled)],
      [{ text: "Conteúdo comercial: não (altere no Estúdio)", callback_data: "noop" }],
      [{ text: "📄 Music Usage Confirmation do TikTok", url: MUSIC_POLICY }],
      [{ text: `✅ ${d.when === "now" ? "Publicar agora" : "Agendar"} — concordo com a Music Usage Confirmation`, callback_data: `tok:${id}` }],
      [{ text: "↩ Voltar", callback_data: `tb:${id}` }],
    ],
  };
}

async function setKeyboard(messageId: number | undefined, markup: object) {
  if (!messageId) return;
  await call("editMessageReplyMarkup", { chat_id: settings.telegram.chatId, message_id: messageId, reply_markup: markup }).catch(() => {});
}

async function onCallback(q: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } }) {
  if (String(q.message?.chat.id) !== settings.telegram.chatId) return;
  const [action, idStr, arg] = (q.data ?? "").split(":");
  const id = Number(idStr);
  const msgId = q.message?.message_id;
  let text = "";
  try {
    if (action === "ap" || action === "now") {
      const clip = getClip(id);
      const ch = clip && getChannel(getJob(clip.job_id)!.channel_id);
      if (ch && needsTikTokChoices(ch)) {
        const info = await tiktokCreatorInfo(ch).catch((e: Error) => {
          throw new Error(explainTikTokError(e.message));
        });
        const d: TikTokDraft = { when: action === "now" ? "now" : undefined, info, privacy: null, comment: false, duet: false, stitch: false };
        drafts.set(id, d);
        await setKeyboard(msgId, tiktokKeyboard(id, d));
        text = "Escolha as opções de publicação no TikTok";
      } else if (action === "ap") {
        text = `Agendado para ${fmtWhen((await approve(id)).scheduled_at)}`;
      } else {
        await approve(id, "now");
        text = "Publicando agora…";
      }
    }
    const d = drafts.get(id);
    if (d && action === "tp") {
      d.privacy = d.info.privacy_level_options[Number(arg)] ?? null;
      await setKeyboard(msgId, tiktokKeyboard(id, d));
    }
    if (d && action === "tpc") {
      d.privacy = null;
      await setKeyboard(msgId, tiktokKeyboard(id, d));
    }
    if (d && action === "tc") {
      const key = ({ c: "comment", d: "duet", s: "stitch" } as const)[arg as "c" | "d" | "s"];
      if (key) d[key] = !d[key];
      await setKeyboard(msgId, tiktokKeyboard(id, d));
    }
    if (d && action === "tok") {
      const clip = getClip(id)!;
      const fresh = await approve(id, d.when, {
        title: clip.caption,
        privacy_level: d.privacy ?? "",
        allow_comment: d.comment,
        allow_duet: d.duet,
        allow_stitch: d.stitch,
        brand_organic: false,
        brand_content: false,
      });
      drafts.delete(id);
      text = d.when === "now" ? "Publicando agora… pode levar alguns minutos para aparecer no perfil." : `Agendado para ${fmtWhen(fresh.scheduled_at)}`;
    }
    if (action === "tb") {
      drafts.delete(id);
      await setKeyboard(msgId, reviewKeyboard(id));
    }
    if (action === "rj") {
      drafts.delete(id);
      reject(id);
      text = "Rejeitado";
    }
  } catch (e) {
    text = (e as Error).message.slice(0, 190);
  }
  await call("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
}

/**
 * Chats que mandaram mensagem ao bot enquanto nenhum chat estava autorizado. O dashboard lista e o
 * usuário escolhe qual autorizar — o bot nunca se autoriza sozinho para quem chegar primeiro.
 */
export const chatCandidates = new Map<string, { id: string; name: string; at: string }>();

async function onMessage(m: { chat: { id: number; title?: string; first_name?: string; last_name?: string; username?: string }; text?: string }) {
  const chat = String(m.chat.id);
  if (!settings.telegram.chatId) {
    const name = m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") || m.chat.username || chat;
    chatCandidates.set(chat, { id: chat, name, at: new Date().toISOString() });
    bus.emit("change", { table: "settings" });
    await call("sendMessage", { chat_id: chat, text: `Recebi! Agora abra o dashboard → Canais → Contas conectadas e clique em "Autorizar este chat" (${name}).` });
    return;
  }
  if (chat !== settings.telegram.chatId) return;
  const cmd = (m.text ?? "").split(/[\s@]/)[0];
  if (cmd === "/agenda") {
    const next = all<Clip & { channel: string }>(
      `SELECT c.*, ch.name AS channel FROM clips c JOIN jobs j ON j.id = c.job_id JOIN channels ch ON ch.id = j.channel_id
       WHERE c.status = 'SCHEDULED' ORDER BY c.scheduled_at LIMIT 15`,
    );
    await send(next.length ? `🗓 <b>Agenda</b>\n${next.map((c) => `${fmtWhen(c.scheduled_at)} · ${esc(c.channel)} · ${esc(c.title)}`).join("\n")}` : "Agenda vazia.");
  }
  if (cmd === "/status" || cmd === "/start") {
    const count = (sql: string) => (get<{ n: number }>(sql)?.n ?? 0);
    const w = all<{ name: string; last_seen: string; task: string }>("SELECT * FROM workers ORDER BY last_seen DESC");
    const online = w.filter((x) => Date.now() - Date.parse(x.last_seen) < 120_000);
    await send(
      `📊 Fila: ${count("SELECT COUNT(*) n FROM jobs WHERE status IN ('QUEUED','DOWNLOADING','TRANSCRIBING','ANALYZING')")} vídeos · ` +
        `${count("SELECT COUNT(*) n FROM clips WHERE status IN ('RENDER_QUEUED','RENDERING')")} renders\n` +
        `👀 Revisão: ${count("SELECT COUNT(*) n FROM clips WHERE status = 'PENDING_REVIEW'")} · 🗓 Agendados: ${count("SELECT COUNT(*) n FROM clips WHERE status = 'SCHEDULED'")}\n` +
        `🖥 Workers: ${online.length ? online.map((x) => `${esc(x.name)} (${esc(x.task || "ocioso")})`).join(", ") : "nenhum online"}\n\n/agenda — próximas postagens`,
    );
  }
}

/** Dados do bot para o dashboard (valida o token). */
export async function telegramBotInfo(): Promise<{ username: string } | { error: string } | null> {
  if (!settings.telegram.token) return null;
  try {
    return await call<{ username: string }>("getMe", {});
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function telegramTest() {
  if (!enabled()) throw new Error("Configure o token e autorize um chat primeiro");
  await call("sendMessage", { chat_id: settings.telegram.chatId, text: "✅ Central de Cortes conectada. Os cortes prontos chegarão aqui para aprovação." });
}

/** Long polling que acompanha mudanças de token feitas pelo dashboard sem reiniciar o hub. */
export async function startTelegram() {
  let offset = 0;
  let activeToken = "";
  for (;;) {
    const token = settings.telegram.token;
    if (!token) {
      activeToken = "";
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (token !== activeToken) {
      activeToken = token;
      offset = 0;
      chatCandidates.clear();
      console.log("[telegram] bot ativo (long polling)");
    }
    try {
      await tg.catchUp();
      const updates = await call<any[]>("getUpdates", { offset, timeout: 20, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) await onCallback(u.callback_query);
        else if (u.message) await onMessage(u.message);
      }
    } catch (e) {
      console.error(`[telegram] ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}
