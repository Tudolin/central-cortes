import type { Channel, Clip, Job } from "../db.ts";
import { hms } from "../proc.ts";

/** Link do vídeo original já posicionado no segundo do corte (trata URLs que já têm query string). */
export function timestampLink(job: Pick<Job, "video_url" | "video_id">, seconds: number): string {
  const t = Math.floor(seconds);
  if (job.video_id && /youtu/.test(job.video_url)) return `https://youtu.be/${job.video_id}?t=${t}s`;
  if (!job.video_url) return "";
  return `${job.video_url}${job.video_url.includes("?") ? "&" : "?"}t=${t}s`;
}

/** Hashtag no formato que a busca encontra: minúscula, sem acento, só letras e números ("#Saúde Mental" → "saudemental"). */
export const cleanTag = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const MAX_TAGS = 5;
const TAG_LINE = /^\s*(#[^\s#]+\s*)+$/;

/** Hashtags fixas do canal (as do template de legenda), já limpas. */
export const fixedTags = (template: string) =>
  [...new Set(template.split("\n").map((l) => l.replace(/\{\w+\}/g, "")).filter((l) => TAG_LINE.test(l)).flatMap((l) => l.match(/#[^\s#]+/g) ?? []).map(cleanTag))];

/**
 * Junta as hashtags da legenda numa linha só, no fim: as do assunto do corte primeiro (o YouTube mostra as
 * 3 primeiras acima do título e o TikTok usa as primeiras para classificar), depois as fixas do canal.
 * Sem repetidas nem acento, no máximo 5: poucas e certeiras rendem mais (o YouTube ignora todas acima de 15).
 */
export function tidyHashtags(caption: string, subject = ""): string {
  const lines = caption.split("\n");
  const inLines = lines.filter((l) => TAG_LINE.test(l)).flatMap((l) => l.match(/#[^\s#]+/g) ?? []);
  const seen = new Set<string>();
  const tags = [...(subject.match(/#[^\s#]+/g) ?? []), ...inLines]
    .map(cleanTag)
    .filter((t) => t.length >= 3 && t.length <= 30 && !seen.has(t) && !!seen.add(t))
    .slice(0, MAX_TAGS);
  const body = lines.filter((l) => !TAG_LINE.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return tags.length ? `${body}\n\n${tags.map((t) => "#" + t).join(" ")}` : body;
}

export function renderCaption(
  template: string, job: Pick<Job, "video_url" | "video_id" | "uploader" | "title">, title: string, startS: number,
  extra: { pillar?: string; hashtags?: string } = {},
): string {
  const link = timestampLink(job, startS);
  const text = template
    .replaceAll("{fonte}", job.uploader || job.title)
    .replaceAll("{titulo_video}", job.title)
    .replaceAll("{pilar}", extra.pillar ?? "")
    .replaceAll("{hashtags_assunto}", extra.hashtags ?? "")
    // O template clássico "{url}?t={ts}s" gera URL inválida quando a URL já tem "?v=".
    .replace("{url_video_original}?t={timestamp_segundos}s", link)
    .replaceAll("{url_com_timestamp}", link)
    .replaceAll("{titulo_corte}", title)
    .replaceAll("{url_video_original}", job.video_url)
    .replaceAll("{timestamp_segundos}", String(Math.floor(startS)));
  return tidyHashtags(text, extra.hashtags);
}

/** Monta o JSON no schema do contrato (pipeline_metadata + cortes) a partir do estado atual do banco. */
export function buildResult(ch: Channel, job: Job, clips: Clip[]) {
  return {
    pipeline_metadata: {
      canal_id: ch.id,
      job_id: job.id,
      video_titulo: job.title,
      total_cortes_encontrados: clips.length,
      modelo: job.model,
      tokens_estimados_analise: job.tokens_in + job.tokens_out + job.tokens_cache_read + job.tokens_cache_write,
      custo_estimado_usd: job.cost_usd,
    },
    cortes: clips.map((c) => ({
      id_corte: c.idx,
      start_time: hms(c.start_s),
      end_time: hms(c.end_s),
      start_seconds: c.start_s,
      end_seconds: c.end_s,
      duracao_segundos: Math.round((c.end_s - c.start_s) * 10) / 10,
      score_viral: c.score,
      gancho_impacto: c.hook,
      titulo_corte: c.title,
      legenda_social_formatada: c.caption,
      reframe_config: {
        layout_type: c.layout,
        crop_aspect_ratio: "9:16",
        tracking_sensitivity: "high",
        zoom_on_emphasis: Boolean(c.zoom),
      },
      subtitles_config: {
        style: "hormozi_dark_bauhaus",
        max_words_per_frame: ch.max_words_per_frame,
        highlight_color: ch.highlight_color,
        palavras_destaque: JSON.parse(c.keywords) as string[],
      },
      status_pipeline: c.status,
    })),
  };
}
