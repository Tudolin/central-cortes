import { existsSync } from "node:fs";
import { config } from "../config.ts";
import { settings } from "./settings.ts";
import { all, get, getChannel, getClip, getJob, run, updateClip, type Channel, type Clip, type Platform, type Post } from "../db.ts";
import { bus } from "../events.ts";
import { buildResult } from "../pipeline/caption.ts";
import { clipPath } from "./media.ts";
import { explainTikTokError, tiktokCreatorInfo, tiktokUpload, validateTikTokSettings, type TikTokPostSettings } from "./publish/tiktok.ts";
import { youtubeUpload } from "./publish/youtube.ts";
import { tg } from "./telegram.ts";

const PUBLISHERS: Record<Platform, (ch: Channel, clip: Clip, file: string) => Promise<{ status: "OK" | "INBOX"; external_id: string; url: string; variant?: string }>> = {
  youtube: youtubeUpload,
  tiktok: tiktokUpload,
};
const BACKOFF_MIN = [5, 20, 60];

export const targetsOf = (ch: Channel) => (JSON.parse(ch.publish_targets || "[]") as Platform[]).filter((p) => p in PUBLISHERS);

/** Dois cortes do mesmo vídeo de origem ficam a pelo menos 3 dias de distância na mesma plataforma. */
const SOURCE_GAP_MS = 3 * 86400_000;
/** Segundos em comum a partir dos quais dois cortes do mesmo vídeo contam como o mesmo trecho. */
const OVERLAP_S = 5;

/** Vídeo de origem do job: o id do YouTube quando há (o mesmo vídeo com outro link é o mesmo vídeo). */
export const sourceOf = (job: { video_id: string; source: string }) => job.video_id || job.source;

/**
 * Corte do canal, do mesmo vídeo de origem, que repete o trecho [start, end] — o YouTube trata trecho
 * repetido como conteúdo duplicado. `statuses` limita a quais cortes comparar.
 */
export function overlapOf(channelId: string, src: string, start: number, end: number, statuses: string[], exceptId = 0) {
  return get<Clip>(
    `SELECT c.* FROM clips c JOIN jobs j ON j.id = c.job_id
     WHERE j.channel_id = ? AND COALESCE(NULLIF(j.video_id, ''), j.source) = ? AND c.id != ?
       AND c.status IN (${statuses.map(() => "?").join(",")}) AND MIN(c.end_s, ?) - MAX(c.start_s, ?) >= ?
     ORDER BY c.id LIMIT 1`,
    channelId, src, exceptId, ...statuses, end, start, OVERLAP_S,
  );
}
/** A fila própria de uma plataforma só considera cortes aprovados nos últimos 14 dias. */
const PLATFORM_LOOKBACK_MS = 14 * 86400_000;

const slotList = (s: string) => s.split(/[,\s]+/).filter((x) => /^\d{1,2}:\d{2}$/.test(x));

/**
 * Horários próprios por plataforma (ex.: YouTube 1x/dia enquanto o TikTok segue 3x/dia).
 * Pelo menos uma plataforma segue os horários do canal: é ela que marca o corte como publicado.
 */
export function ownSlots(ch: Channel): Partial<Record<Platform, string>> {
  const conf = JSON.parse(ch.platform_slots || "{}") as Record<string, string>;
  const targets = targetsOf(ch);
  const out: Partial<Record<Platform, string>> = {};
  for (const p of targets) if (slotList(conf[p] ?? "").length) out[p] = slotList(conf[p]).join(",");
  return Object.keys(out).length >= targets.length ? {} : out;
}
export const mainTargets = (ch: Channel) => targetsOf(ch).filter((p) => !(p in ownSlots(ch)));

/** "YYYY-MM-DD HH:MM:SS" (datetime do SQLite, UTC) ou ISO → ms. */
const ms = (s: string) => Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");

/**
 * Distribui itens (do melhor para o pior) nos horários livres, sem pôr dois cortes do mesmo vídeo
 * a menos de 3 dias um do outro. Se nenhum horário respeitar o intervalo, usa o primeiro livre.
 */
function spread<T extends { src: string }>(items: T[], slots: string[], fixed: { src: string; t: number }[]) {
  const used = new Set<string>();
  const placed = [...fixed];
  const out = new Map<T, string>();
  const clash = (src: string, t: number) => placed.some((p) => p.src === src && Math.abs(p.t - t) < SOURCE_GAP_MS);
  for (const it of items) {
    const slot = slots.find((s) => !used.has(s) && !clash(it.src, Date.parse(s))) ?? slots.find((s) => !used.has(s));
    if (!slot) continue;
    used.add(slot);
    placed.push({ src: it.src, t: Date.parse(slot) });
    out.set(it, slot);
  }
  return out;
}

/** Horários "HH:MM" a partir de agora, no fuso do servidor (TZ). */
function upcomingSlots(ch: Channel, from: Date, days = 30, slotStr = ch.schedule_slots): Date[] {
  const slots = slotStr.split(/[,\s]+/).map((s) => s.match(/^(\d{1,2}):(\d{2})$/)).filter((m): m is RegExpMatchArray => !!m);
  const out: Date[] = [];
  for (let d = 0; d < days; d++) {
    for (const [, h, m] of slots) {
      const t = new Date(from);
      t.setDate(t.getDate() + d);
      t.setHours(+h, +m, 0, 0);
      if (t.getTime() > from.getTime() + 5 * 60_000) out.push(t);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Redistribui os cortes aprovados (não travados) do canal nos próximos horários livres,
 * maior score primeiro. Horários definidos à mão (schedule_locked) ficam onde estão.
 */
export function rebalance(channelId: string) {
  const ch = getChannel(channelId);
  if (!ch) return;
  const SRC = "COALESCE(NULLIF(j.video_id, ''), j.source)";
  const scheduled = all<Clip & { src: string }>(
    `SELECT c.*, ${SRC} AS src FROM clips c JOIN jobs j ON j.id = c.job_id WHERE j.channel_id = ? AND c.status = 'SCHEDULED'`,
    channelId,
  );
  // Fixos: travados à mão, em nova tentativa e publicados nos últimos 3 dias (contam para o intervalo por vídeo).
  const fixedClips = scheduled.filter((c) => c.schedule_locked || c.publish_attempts > 0);
  const recent = all<{ src: string; published_at: string }>(
    `SELECT ${SRC} AS src, c.published_at FROM clips c JOIN jobs j ON j.id = c.job_id
     WHERE j.channel_id = ? AND c.status IN ('PUBLISHED', 'PUBLISHING') AND c.published_at > ?`,
    channelId, new Date(Date.now() - SOURCE_GAP_MS).toISOString(),
  );
  const fixed = [
    ...fixedClips.filter((c) => c.scheduled_at).map((c) => ({ src: c.src, t: Date.parse(c.scheduled_at!) })),
    ...recent.map((r) => ({ src: r.src, t: Date.parse(r.published_at) })),
  ];
  const taken = new Set(fixedClips.map((c) => c.scheduled_at));
  const queue = scheduled.filter((c) => !c.schedule_locked && !c.publish_attempts).sort((a, b) => b.score - a.score || a.id - b.id);
  // Horizonte com folga para todos os aprovados mesmo respeitando o intervalo por vídeo
  // (horizonte fixo de 30 dias jogava o excedente no "1 por hora", tudo no mesmo dia).
  const perDay = Math.max(1, slotList(ch.schedule_slots).length);
  const days = Math.max(45, Math.ceil(queue.length / perDay) * 2 + 7);
  const free = upcomingSlots(ch, new Date(), days).map((d) => d.toISOString()).filter((s) => !taken.has(s));
  const plan = spread(queue, free, fixed);
  queue.forEach((c, i) => {
    const slot = plan.get(c) ?? new Date(Date.now() + (i + 1) * 3600_000).toISOString(); // canal sem horários: 1/h
    if (c.scheduled_at !== slot) updateClip(c.id, { scheduled_at: slot });
  });

  // Filas próprias por plataforma (ex.: YouTube 1x/dia). Plataformas sem fila própria perdem os planejados.
  const own = ownSlots(ch);
  for (const p of targetsOf(ch)) if (!(p in own)) dropPlanned(ch.id, p, true);
  for (const [p, slots] of Object.entries(own) as [Platform, string][]) planPlatform(ch, p, slots);
}

function dropPlanned(channelId: string, platform: Platform, includeLocked: boolean) {
  run(
    `DELETE FROM posts WHERE platform = ? AND status = 'PLANNED' ${includeLocked ? "" : "AND locked = 0"}
       AND clip_id IN (SELECT c.id FROM clips c JOIN jobs j ON j.id = c.job_id WHERE j.channel_id = ?)`,
    platform, channelId,
  );
}

/**
 * Fila própria da plataforma: cada horário dela recebe o melhor corte aprovado (últimos 14 dias) que ainda
 * não foi para lá, respeitando o intervalo de 3 dias por vídeo de origem. Os posts ficam como PLANNED.
 */
function planPlatform(ch: Channel, platform: Platform, slotStr: string) {
  // Planejados de cortes que deixaram de estar aprovados (rejeitados, de volta à revisão) saem, mesmo travados.
  run(
    `DELETE FROM posts WHERE status = 'PLANNED' AND clip_id IN (SELECT id FROM clips WHERE status NOT IN ('SCHEDULED', 'PUBLISHING', 'PUBLISHED'))`,
  );
  const SRC = "COALESCE(NULLIF(j.video_id, ''), j.source)";
  const allRows = all<{ id: number; clip_id: number; status: string; locked: number; attempts: number; at: string | null; src: string }>(
    `SELECT p.id, p.clip_id, p.status, p.locked, p.attempts, COALESCE(p.scheduled_at, p.updated_at) AS at, ${SRC} AS src
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN jobs j ON j.id = c.job_id WHERE j.channel_id = ? AND p.platform = ?`,
    ch.id, platform,
  );
  // Planejados automáticos (sem trava, sem tentativa) são refeitos; os demais ficam como estão.
  const replan = new Map(allRows.filter((r) => r.status === "PLANNED" && !r.locked && !r.attempts).map((r) => [r.clip_id, r]));
  const rows = allRows.filter((r) => !replan.has(r.clip_id));
  const has = new Set(rows.map((r) => r.clip_id));
  const fixed = rows.filter((r) => r.at && !["FAILED", "SKIPPED"].includes(r.status)).map((r) => ({ src: r.src, t: ms(r.at!) }));
  const taken = new Set(rows.filter((r) => r.status === "PLANNED" && r.at).map((r) => new Date(ms(r.at!)).toISOString()));
  const candidates = all<Clip & { src: string }>(
    `SELECT c.*, ${SRC} AS src FROM clips c JOIN jobs j ON j.id = c.job_id
     WHERE j.channel_id = ? AND c.status IN ('SCHEDULED', 'PUBLISHING', 'PUBLISHED') AND c.approved_at > ?`,
    ch.id, new Date(Date.now() - PLATFORM_LOOKBACK_MS).toISOString(),
  ).filter((c) => !has.has(c.id)).sort((a, b) => b.score - a.score || a.id - b.id);
  const free = upcomingSlots(ch, new Date(), 30, slotStr).map((d) => d.toISOString()).filter((s) => !taken.has(s));
  // Atualiza no lugar (o id do post não muda: o painel pode estar com ele aberto), cria os novos, apaga os que saíram.
  const plan = spread(candidates, free, fixed);
  for (const [c, slot] of plan) {
    const cur = replan.get(c.id);
    if (cur) {
      if (cur.at !== slot) run("UPDATE posts SET scheduled_at = ? WHERE id = ?", slot, cur.id);
      replan.delete(c.id);
    } else run("INSERT INTO posts (clip_id, platform, status, scheduled_at) VALUES (?, ?, 'PLANNED', ?)", c.id, platform, slot);
  }
  for (const r of replan.values()) run("DELETE FROM posts WHERE id = ?", r.id);
}

/** Aprovação vinda do dashboard ou do Telegram. `when` = horário manual (trava) ou "now". */
/** O canal publica direto no TikTok: cada aprovação precisa das escolhas do usuário para aquele post. */
export const needsTikTokChoices = (ch: Channel) => ch.tiktok_mode === "direct" && targetsOf(ch).includes("tiktok");

/**
 * Aprovação vinda do dashboard ou do Telegram. `when` = horário manual (trava) ou "now".
 * `tiktok` = escolhas de publicação no TikTok (sem elas, mantém as já registradas no corte).
 */
export async function approve(clipId: number, when?: string, tiktok?: Omit<TikTokPostSettings, "consent_at">) {
  const clip = getClip(clipId);
  if (!clip || !["PENDING_REVIEW", "SCHEDULED", "PUBLISH_FAILED"].includes(clip.status)) throw new Error("Corte não está pronto para aprovação");
  const job = getJob(clip.job_id)!;
  const ch = getChannel(job.channel_id)!;
  let tiktokSettings = clip.tiktok_settings;
  if (tiktok) tiktokSettings = JSON.stringify({ ...tiktok, consent_at: new Date().toISOString() } satisfies TikTokPostSettings);
  if (needsTikTokChoices(ch)) {
    const info = await tiktokCreatorInfo(ch).catch((e: Error) => {
      throw new Error(explainTikTokError(e.message));
    });
    const invalid = validateTikTokSettings(tiktokSettings ? JSON.parse(tiktokSettings) : null, info, clip.end_s - clip.start_s);
    if (invalid) throw new Error(invalid);
  }
  const dup = overlapOf(ch.id, sourceOf(job), clip.start_s, clip.end_s, ["SCHEDULED", "PUBLISHING", "PUBLISHED"], clip.id);
  if (dup) throw new Error(`Repete o trecho do corte #${dup.id} ("${dup.title}"), que já foi aprovado`);
  const manual = when === "now" ? new Date(Date.now() + 5_000).toISOString() : when ? new Date(when).toISOString() : null;
  updateClip(clipId, {
    status: "SCHEDULED",
    approved_at: clip.approved_at ?? new Date().toISOString(),
    scheduled_at: manual,
    schedule_locked: manual ? 1 : 0,
    publish_attempts: 0,
    tiktok_settings: tiktokSettings,
    error: "",
  });
  rebalance(job.channel_id);
  const fresh = getClip(clipId)!;
  void tg.clipDecided(fresh, "approved");
  if (manual) void tick();
  return fresh;
}

export function reject(clipId: number) {
  const clip = getClip(clipId);
  if (!clip) throw new Error("Corte não encontrado");
  updateClip(clipId, { status: "REJECTED", scheduled_at: null });
  const job = getJob(clip.job_id)!;
  rebalance(job.channel_id);
  void tg.clipDecided(getClip(clipId)!, "rejected");
}

async function publishClip(clip: Clip) {
  const job = getJob(clip.job_id)!;
  const ch = getChannel(job.channel_id)!;
  const file = clipPath(job.id, clip.id, "mp4");
  updateClip(clip.id, { status: "PUBLISHING", error: "" });

  const errors: string[] = [];
  if (!existsSync(file)) errors.push("arquivo do corte não está no hub");
  else {
    for (const platform of mainTargets(ch)) {
      const done = get<Post>("SELECT * FROM posts WHERE clip_id = ? AND platform = ? AND status IN ('OK', 'INBOX')", clip.id, platform);
      if (done) continue;
      try {
        const r = await PUBLISHERS[platform](ch, clip, file);
        run(
          `INSERT INTO posts (clip_id, platform, status, external_id, url, variant, attempts) VALUES (?,?,?,?,?,?,1)
           ON CONFLICT(clip_id, platform) DO UPDATE SET status = excluded.status, external_id = excluded.external_id,
             url = excluded.url, variant = excluded.variant, error = '', attempts = attempts + 1, updated_at = datetime('now')`,
          clip.id, platform, r.status, r.external_id, r.url, r.variant ?? "",
        );
      } catch (e) {
        const msg = (e as Error).message.slice(0, 1000);
        errors.push(`${platform}: ${msg}`);
        run(
          `INSERT INTO posts (clip_id, platform, status, error, attempts) VALUES (?,?,'FAILED',?,1)
           ON CONFLICT(clip_id, platform) DO UPDATE SET status = 'FAILED', error = excluded.error, attempts = attempts + 1, updated_at = datetime('now')`,
          clip.id, platform, msg,
        );
      }
    }
  }

  if (!errors.length) {
    updateClip(clip.id, { status: "PUBLISHED", published_at: new Date().toISOString(), error: "" });
    await fireWebhook(ch, clip.id);
    await tg.published(getClip(clip.id)!, all<Post>("SELECT * FROM posts WHERE clip_id = ? AND status IN ('OK', 'INBOX')", clip.id));
    return;
  }
  const attempts = clip.publish_attempts + 1;
  if (attempts >= BACKOFF_MIN.length + 1) {
    updateClip(clip.id, { status: "PUBLISH_FAILED", publish_attempts: attempts, error: errors.join("\n") });
    await tg.publishFailed(getClip(clip.id)!, errors);
  } else {
    const retry = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000).toISOString();
    updateClip(clip.id, { status: "SCHEDULED", publish_attempts: attempts, scheduled_at: retry, error: errors.join("\n") });
  }
}

/** Post da fila própria de uma plataforma (ex.: YouTube 1x/dia). */
async function publishPlanned(p: Post) {
  const clip = getClip(p.clip_id)!;
  const ch = getChannel(getJob(clip.job_id)!.channel_id)!;
  try {
    const r = await PUBLISHERS[p.platform](ch, clip, clipPath(clip.job_id, clip.id, "mp4"));
    run(
      "UPDATE posts SET status = ?, external_id = ?, url = ?, variant = ?, error = '', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?",
      r.status, r.external_id, r.url, r.variant ?? "", p.id,
    );
    await tg.published(clip, [get<Post>("SELECT * FROM posts WHERE id = ?", p.id)!]);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 1000);
    const attempts = p.attempts + 1;
    if (attempts > BACKOFF_MIN.length) {
      run("UPDATE posts SET status = 'FAILED', error = ?, attempts = ?, updated_at = datetime('now') WHERE id = ?", msg, attempts, p.id);
      await tg.publishFailed(clip, [`${p.platform}: ${msg}`]);
    } else {
      const retry = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000).toISOString();
      run("UPDATE posts SET error = ?, attempts = ?, scheduled_at = ? WHERE id = ?", msg, attempts, retry, p.id);
    }
  }
  bus.emit("change", { table: "posts" });
}

async function fireWebhook(ch: Channel, clipId: number) {
  if (!ch.webhook_url) return;
  const clip = getClip(clipId)!;
  const job = getJob(clip.job_id)!;
  try {
    await fetch(ch.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "clip.published",
        channel_id: ch.id,
        posts: all<Post>("SELECT platform, status, url, external_id FROM posts WHERE clip_id = ?", clipId),
        video_file_url: settings.publicUrl ? `${settings.publicUrl}/media/clip/${clipId}.mp4` : null,
        corte: buildResult(ch, job, [clip]).cortes[0],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error(`[webhook] ${ch.id}: ${(e as Error).message}`);
  }
}

const warnedMissing = new Set<number>();
/** Avisa uma vez quando um corte passou do horário há 30 min esperando o vídeo final (PC desligado?). */
function warnMissingFinal(c: Clip) {
  if (c.detail !== "aguardando vídeo final do PC") updateClip(c.id, { detail: "aguardando vídeo final do PC" });
  const late = Date.now() - Date.parse(c.scheduled_at ?? "") > 30 * 60_000;
  if (late && !warnedMissing.has(c.id)) {
    warnedMissing.add(c.id);
    void tg.alert(`⏳ "${c.title}" passou do horário esperando o vídeo final e foi para o próximo horário livre. Ligue o PC com o worker rodando.`);
  }
}

/** Aviso antecipado: PC desligado e cortes das próximas 24 h ainda sem vídeo final no notebook. */
let offlineWarnedAt = 0;
function warnWorkerOffline() {
  const w = get<{ last_seen: string }>("SELECT last_seen FROM workers ORDER BY last_seen DESC LIMIT 1");
  const offlineH = w ? (Date.now() - Date.parse(w.last_seen)) / 3600_000 : Infinity;
  if (offlineH < 1) {
    offlineWarnedAt = 0;
    return;
  }
  if (Date.now() - offlineWarnedAt < 12 * 3600_000) return;
  const soon = all<Clip>("SELECT * FROM clips WHERE status = 'SCHEDULED' AND scheduled_at <= ?", new Date(Date.now() + 24 * 3600_000).toISOString())
    .filter((c) => !existsSync(clipPath(c.job_id, c.id, "mp4")));
  if (!soon.length) return;
  offlineWarnedAt = Date.now();
  void tg.alert(
    `🖥️ O worker do PC está sem contato há ${Number.isFinite(offlineH) ? Math.round(offlineH) + " h" : "muito tempo"} e ${soon.length} corte(s) das próximas 24 h ` +
      "ainda não têm vídeo final no notebook. Ligue o PC para não atrasar as postagens.",
  );
}

let busy = false;
export async function tick() {
  if (busy) return;
  busy = true;
  try {
    // Corte que perdeu o horário (vídeo final não chegou a tempo) vai para o próximo horário livre,
    // em vez de vários saírem em rajada quando o PC volta.
    const stale = all<Clip & { channel_id: string }>(
      `SELECT c.*, j.channel_id FROM clips c JOIN jobs j ON j.id = c.job_id
       WHERE c.status = 'SCHEDULED' AND c.schedule_locked = 0 AND c.publish_attempts = 0 AND c.scheduled_at < ?`,
      new Date(Date.now() - 2 * 3600_000).toISOString(),
    );
    const stalePosts = all<{ channel_id: string }>(
      `SELECT DISTINCT j.channel_id FROM posts p JOIN clips c ON c.id = p.clip_id JOIN jobs j ON j.id = c.job_id
       WHERE p.status = 'PLANNED' AND p.locked = 0 AND p.attempts = 0 AND p.scheduled_at < ?`,
      new Date(Date.now() - 2 * 3600_000).toISOString(),
    );
    for (const ch of new Set([...stale.map((c) => c.channel_id), ...stalePosts.map((p) => p.channel_id)])) rebalance(ch);
    warnWorkerOffline();
    // Um por vez: respeita rate limits das plataformas e o upload lento do notebook.
    const waiting = new Set<number>();
    for (;;) {
      const due = all<Clip>("SELECT * FROM clips WHERE status = 'SCHEDULED' AND scheduled_at <= ? ORDER BY scheduled_at", new Date().toISOString())
        .find((c) => !waiting.has(c.id));
      if (!due) break;
      // Vídeo final ainda no PC: espera o worker enviar (não conta como tentativa de publicação).
      if (!existsSync(clipPath(due.job_id, due.id, "mp4"))) {
        waiting.add(due.id);
        warnMissingFinal(due);
        continue;
      }
      await publishClip(due);
    }
    for (const p of all<Post & { job_id: number }>(
      "SELECT p.*, c.job_id FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.status = 'PLANNED' AND p.scheduled_at <= ? ORDER BY p.scheduled_at",
      new Date().toISOString(),
    )) {
      if (existsSync(clipPath(p.job_id, p.clip_id, "mp4"))) await publishPlanned(p);
    }
  } catch (e) {
    console.error("[agenda]", e);
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  // Recupera publicação interrompida por reinício.
  run("UPDATE clips SET status = 'SCHEDULED' WHERE status = 'PUBLISHING'");
  for (const { id } of all<{ id: string }>("SELECT id FROM channels")) rebalance(id);
  setInterval(() => void tick(), 30_000);
  bus.on("channel-saved", (id: string) => rebalance(id));
  void tick();
}
