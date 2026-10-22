import { existsSync } from "node:fs";
import { config } from "../config.ts";
import { all, get, getChannel, getClip, getJob, run, updateClip, type Channel, type Clip, type Platform, type Post } from "../db.ts";
import { bus } from "../events.ts";
import { buildResult } from "../pipeline/caption.ts";
import { clipPath, removeClipFiles } from "./media.ts";
import { tiktokUpload } from "./publish/tiktok.ts";
import { youtubeUpload } from "./publish/youtube.ts";
import { tg } from "./telegram.ts";

const PUBLISHERS: Record<Platform, (ch: Channel, clip: Clip, file: string) => Promise<{ status: "OK" | "INBOX"; external_id: string; url: string }>> = {
  youtube: youtubeUpload,
  tiktok: tiktokUpload,
};
const BACKOFF_MIN = [5, 20, 60];

export const targetsOf = (ch: Channel) => (JSON.parse(ch.publish_targets || "[]") as Platform[]).filter((p) => p in PUBLISHERS);

/** Horários "HH:MM" do canal a partir de agora, no fuso do servidor (TZ). */
function upcomingSlots(ch: Channel, from: Date, days = 30): Date[] {
  const slots = ch.schedule_slots.split(/[,\s]+/).map((s) => s.match(/^(\d{1,2}):(\d{2})$/)).filter((m): m is RegExpMatchArray => !!m);
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
  const scheduled = all<Clip & { channel_id: string }>(
    `SELECT c.* FROM clips c JOIN jobs j ON j.id = c.job_id WHERE j.channel_id = ? AND c.status = 'SCHEDULED' AND c.publish_attempts = 0`,
    channelId,
  );
  const taken = new Set(scheduled.filter((c) => c.schedule_locked).map((c) => c.scheduled_at));
  const free = upcomingSlots(ch, new Date()).map((d) => d.toISOString()).filter((s) => !taken.has(s));
  const queue = scheduled.filter((c) => !c.schedule_locked).sort((a, b) => b.score - a.score || a.id - b.id);
  queue.forEach((c, i) => {
    const slot = free[i] ?? new Date(Date.now() + (i + 1) * 3600_000).toISOString(); // canal sem horários: 1/h
    if (c.scheduled_at !== slot) updateClip(c.id, { scheduled_at: slot });
  });
}

/** Aprovação vinda do dashboard ou do Telegram. `when` = horário manual (trava) ou "now". */
export function approve(clipId: number, when?: string) {
  const clip = getClip(clipId);
  if (!clip || !["PENDING_REVIEW", "SCHEDULED", "PUBLISH_FAILED"].includes(clip.status)) throw new Error("Corte não está pronto para aprovação");
  const job = getJob(clip.job_id)!;
  const manual = when === "now" ? new Date(Date.now() + 5_000).toISOString() : when ? new Date(when).toISOString() : null;
  updateClip(clipId, {
    status: "SCHEDULED",
    approved_at: clip.approved_at ?? new Date().toISOString(),
    scheduled_at: manual,
    schedule_locked: manual ? 1 : 0,
    publish_attempts: 0,
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
    for (const platform of targetsOf(ch)) {
      const done = get<Post>("SELECT * FROM posts WHERE clip_id = ? AND platform = ? AND status != 'FAILED'", clip.id, platform);
      if (done) continue;
      try {
        const r = await PUBLISHERS[platform](ch, clip, file);
        run(
          `INSERT INTO posts (clip_id, platform, status, external_id, url, attempts) VALUES (?,?,?,?,?,1)
           ON CONFLICT(clip_id, platform) DO UPDATE SET status = excluded.status, external_id = excluded.external_id,
             url = excluded.url, error = '', attempts = attempts + 1, updated_at = datetime('now')`,
          clip.id, platform, r.status, r.external_id, r.url,
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
    await tg.published(getClip(clip.id)!, all<Post>("SELECT * FROM posts WHERE clip_id = ?", clip.id));
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
        video_file_url: config.publicUrl ? `${config.publicUrl}/media/clip/${clipId}.mp4` : null,
        corte: buildResult(ch, job, [clip]).cortes[0],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error(`[webhook] ${ch.id}: ${(e as Error).message}`);
  }
}

let busy = false;
export async function tick() {
  if (busy) return;
  busy = true;
  try {
    // Um por vez: respeita rate limits das plataformas e o upload lento do notebook.
    for (;;) {
      const due = get<Clip>("SELECT * FROM clips WHERE status = 'SCHEDULED' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1", new Date().toISOString());
      if (!due) break;
      await publishClip(due);
    }
  } catch (e) {
    console.error("[agenda]", e);
  } finally {
    busy = false;
  }
}

/** Libera disco do notebook: mp4/proxy de publicados após N dias, rejeitados após 2 dias. */
function cleanup() {
  const old = all<Clip>(
    `SELECT * FROM clips WHERE (status = 'PUBLISHED' AND published_at < ?) OR (status = 'REJECTED' AND updated_at < datetime('now', '-2 days'))`,
    new Date(Date.now() - config.retentionDays * 86400_000).toISOString(),
  );
  for (const c of old) removeClipFiles(c.job_id, c.id, c.status === "PUBLISHED" ? ["mp4", "proxy"] : ["mp4", "jpg", "proxy"]);
}

export function startScheduler() {
  // Recupera publicação interrompida por reinício.
  run("UPDATE clips SET status = 'SCHEDULED' WHERE status = 'PUBLISHING'");
  for (const { id } of all<{ id: string }>("SELECT id FROM channels")) rebalance(id);
  setInterval(() => void tick(), 30_000);
  setInterval(cleanup, 6 * 3600_000);
  bus.on("channel-saved", (id: string) => rebalance(id));
  void tick();
}
