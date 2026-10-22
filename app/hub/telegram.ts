import { existsSync, openAsBlob, statSync } from "node:fs";
import { config } from "../config.ts";
import { all, get, getChannel, getClip, getJob, updateClip, type Clip, type Job, type Post } from "../db.ts";
import { clipPath } from "./media.ts";
import { approve, reject } from "./schedule.ts";

/**
 * Bot de aprovação via long polling (não precisa de URL pública nem conflita com o webhook do ig-agent,
 * desde que seja um bot próprio). Só aceita comandos do TELEGRAM_CHAT_ID configurado.
 */
const enabled = () => !!(config.telegram.token && config.telegram.chatId);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: config.timezone, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const dur = (c: Clip) => {
  const s = Math.round(c.end_s - c.start_s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const studioLink = (clipId: number) => (config.publicUrl.startsWith("https://") ? `${config.publicUrl}/#clip=${clipId}` : "");

async function call<T = any>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const r = await fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
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
  await call("sendMessage", { chat_id: config.telegram.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }).catch((e) =>
    console.error(`[telegram] ${e.message}`),
  );
}

export const tg = {
  /** Corte renderizado: envia o vídeo com botões de decisão. */
  async reviewReady(clipId: number) {
    if (!enabled()) return;
    const c = getClip(clipId);
    if (!c) return;
    try {
      const mp4 = clipPath(c.job_id, c.id, "mp4");
      const jpg = clipPath(c.job_id, c.id, "jpg");
      const fd = new FormData();
      fd.set("chat_id", config.telegram.chatId);
      fd.set("caption", reviewCaption(c));
      fd.set("parse_mode", "HTML");
      fd.set("reply_markup", JSON.stringify(reviewKeyboard(c.id)));
      let method = "sendVideo";
      if (existsSync(mp4) && statSync(mp4).size < 49 * 1024 * 1024) {
        fd.set("video", await openAsBlob(mp4, { type: "video/mp4" }), "corte.mp4");
        fd.set("supports_streaming", "true");
        fd.set("width", "1080");
        fd.set("height", "1920");
      } else {
        method = "sendPhoto";
        fd.set("photo", await openAsBlob(jpg, { type: "image/jpeg" }), "corte.jpg");
      }
      // Re-render: apaga a mensagem antiga para não ficar botão órfão.
      if (c.tg_message_id) await call("deleteMessage", { chat_id: config.telegram.chatId, message_id: c.tg_message_id }).catch(() => {});
      const msg = await call<{ message_id: number }>(method, fd);
      updateClip(c.id, { tg_message_id: msg.message_id });
    } catch (e) {
      console.error(`[telegram] reviewReady ${clipId}: ${(e as Error).message}`);
    }
  },

  /** Decisão tomada (em qualquer lugar): atualiza a mensagem original e tira os botões. */
  async clipDecided(c: Clip, kind: "approved" | "rejected") {
    if (!enabled() || !c.tg_message_id) return;
    const footer = kind === "approved" ? `✅ <b>Aprovado</b> — agendado para ${fmtWhen(c.scheduled_at)}` : "❌ <b>Rejeitado</b>";
    await call("editMessageCaption", {
      chat_id: config.telegram.chatId,
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

async function onCallback(q: { id: string; data?: string; message?: { chat: { id: number } } }) {
  if (String(q.message?.chat.id) !== config.telegram.chatId) return;
  const [action, idStr] = (q.data ?? "").split(":");
  const id = Number(idStr);
  let text = "";
  try {
    if (action === "ap") text = `Agendado para ${fmtWhen(approve(id).scheduled_at)}`;
    if (action === "now") {
      approve(id, "now");
      text = "Publicando agora…";
    }
    if (action === "rj") {
      reject(id);
      text = "Rejeitado";
    }
  } catch (e) {
    text = (e as Error).message;
  }
  await call("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
}

async function onMessage(m: { chat: { id: number }; text?: string }) {
  const chat = String(m.chat.id);
  if (!config.telegram.chatId) {
    // Configuração inicial: descobre o chat id.
    await call("sendMessage", { chat_id: chat, text: `Seu chat id é ${chat}. Coloque TELEGRAM_CHAT_ID=${chat} no .env do hub e reinicie.` });
    return;
  }
  if (chat !== config.telegram.chatId) return;
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

export async function startTelegram() {
  if (!config.telegram.token) return;
  console.log("[telegram] bot ativo (long polling)");
  let offset = 0;
  for (;;) {
    try {
      const updates = await call<any[]>("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
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
