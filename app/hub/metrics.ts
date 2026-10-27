/**
 * Desempenho dos cortes publicados.
 *
 * - YouTube: estatísticas pela Data API com o OAuth do canal (escopo youtube.readonly, já concedido).
 * - TikTok: o robô abre a lista de publicações do TikTok Studio com a sessão do canal e lê os números.
 *   Os vídeos do TikTok são ligados aos cortes pela legenda (o robô publica com a legenda do corte).
 *
 * Coleta a cada 6 h (e pelo botão "Atualizar" do painel). Os melhores e piores cortes de cada canal
 * entram no prompt da IA como referência do que funciona com aquele público (performanceNotes).
 */
import { all, credentialsOf, getChannel, run, type Channel } from "../db.ts";
import { bus } from "../events.ts";
import { youtubeStats } from "./publish/youtube.ts";
import { robotStatus, tiktokStudioItems } from "./publish/tiktokWeb.ts";
import { targetsOf } from "./schedule.ts";

const EVERY_MS = 6 * 3600_000;

export const metricsState: { running: boolean; at: string | null; errors: Record<string, string> } = { running: false, at: null, errors: {} };

type PostRow = { id: number; clip_id: number; platform: string; status: string; external_id: string; caption: string; published_at: string | null };

const postsOf = (channelId: string, platform: string) =>
  all<PostRow>(
    `SELECT p.id, p.clip_id, p.platform, p.status, p.external_id, c.caption, c.published_at
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN jobs j ON j.id = c.job_id
     WHERE j.channel_id = ? AND p.platform = ? AND p.status IN ('OK', 'INBOX')`,
    channelId, platform,
  );

async function collectYoutube(ch: Channel) {
  if (!credentialsOf(ch).youtube_refresh_token) return 0;
  const posts = postsOf(ch.id, "youtube").filter((p) => p.external_id);
  if (!posts.length) return 0;
  const stats = await youtubeStats(ch, posts.map((p) => p.external_id));
  const now = new Date().toISOString();
  for (const p of posts) {
    const s = stats.get(p.external_id);
    if (s) run("UPDATE posts SET views = ?, likes = ?, comments = ?, metrics_at = ? WHERE id = ?", s.views, s.likes, s.comments, now, p.id);
  }
  return stats.size;
}

/** Texto comparável: sem acento, pontuação, espaço e caixa. */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

async function collectTiktok(ch: Channel) {
  if (!targetsOf(ch).includes("tiktok") || !robotStatus(ch.id).saved) return 0;
  const posts = postsOf(ch.id, "tiktok");
  if (!posts.length) return 0;
  const items = await tiktokStudioItems(ch.id);
  const used = new Set<string>();
  const now = new Date().toISOString();
  let n = 0;
  for (const p of posts) {
    // Já ligado antes: segue o mesmo vídeo. Senão, procura pela legenda (o mais próximo da data de publicação).
    const known = p.external_id.startsWith("tt:") ? items.find((i) => i.item_id === p.external_id.slice(3)) : undefined;
    const key = norm(p.caption).slice(0, 40);
    const at = p.published_at ? Date.parse(p.published_at) / 1000 : 0;
    const item = known ?? items
      .filter((i) => !used.has(i.item_id) && key.length >= 12 && (norm(i.desc).startsWith(key) || key.startsWith(norm(i.desc).slice(0, 40))))
      .sort((a, b) => Math.abs(a.create_time - at) - Math.abs(b.create_time - at))[0];
    if (!item) continue;
    used.add(item.item_id);
    run(
      "UPDATE posts SET external_id = ?, status = 'OK', views = ?, likes = ?, comments = ?, shares = ?, saves = ?, metrics_at = ? WHERE id = ?",
      `tt:${item.item_id}`, item.views, item.likes, item.comments, item.shares, item.saves, now, p.id,
    );
    n++;
  }
  return n;
}

export async function collectMetrics() {
  if (metricsState.running) return metricsState;
  metricsState.running = true;
  const errors: Record<string, string> = {};
  try {
    for (const { id } of all<{ id: string }>("SELECT id FROM channels")) {
      const ch = getChannel(id)!;
      for (const [platform, fn] of [["youtube", collectYoutube], ["tiktok", collectTiktok]] as const) {
        try {
          const n = await fn(ch);
          if (n) console.log(`[metrics] ${ch.id} ${platform}: ${n} post(s)`);
        } catch (e) {
          errors[`${ch.id}:${platform}`] = (e as Error).message.slice(0, 200);
          console.warn(`[metrics] ${ch.id} ${platform}: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    metricsState.running = false;
    metricsState.at = new Date().toISOString();
    metricsState.errors = errors;
    bus.emit("change", { table: "posts" });
  }
  return metricsState;
}

export function startMetrics() {
  setTimeout(() => void collectMetrics(), 3 * 60_000); // depois do boot, sem disputar com o robô ao subir
  setInterval(() => void collectMetrics(), EVERY_MS);
}

/**
 * Referência para a IA: os cortes publicados do canal que mais e menos renderam (views somadas das plataformas).
 * Só cortes com 48 h ou mais (números já assentados) e só quando há amostra suficiente.
 */
export function performanceNotes(channelId: string): string {
  const rows = all<{ title: string; hook: string; pillar: string; dur: number; views: number; likes: number; comments: number }>(
    `SELECT c.title, c.hook, c.pillar, c.end_s - c.start_s AS dur,
            SUM(p.views) AS views, SUM(p.likes) AS likes, SUM(p.comments) AS comments
     FROM clips c JOIN jobs j ON j.id = c.job_id JOIN posts p ON p.clip_id = c.id
     WHERE j.channel_id = ? AND c.status = 'PUBLISHED' AND p.metrics_at != ''
       AND c.published_at < datetime('now', '-2 days')
     GROUP BY c.id`,
    channelId,
  );
  if (rows.length < 8) return "";
  rows.sort((a, b) => b.views - a.views);
  const n = Math.min(5, Math.floor(rows.length / 3));
  const line = (r: (typeof rows)[number]) =>
    `- "${r.title}" — ${r.views.toLocaleString("pt-BR")} views, ${r.likes} curtidas, ${r.comments} comentários, ${Math.round(r.dur)}s${r.pillar ? `, pilar ${r.pillar}` : ""}. Gancho: ${r.hook}`;
  return `Resultados reais dos cortes já publicados neste canal (views somadas de YouTube e TikTok). Use como referência do que funciona com este público: aprenda o padrão (tipo de gancho, assunto, duração, tom do título), não repita os temas.
Os que mais renderam:
${rows.slice(0, n).map(line).join("\n")}
Os que menos renderam:
${rows.slice(-n).map(line).join("\n")}`;
}
