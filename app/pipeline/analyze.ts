import Anthropic from "@anthropic-ai/sdk";
import { config, PRICING, type Effort } from "../config.ts";
import type { Channel, Layout } from "../db.ts";
import { compactTranscript, type Transcript } from "./transcribe.ts";

const client = new Anthropic();

export interface CutProposal {
  start_s: number;
  end_s: number;
  score: number;
  hook: string;
  title: string;
  layout: Layout;
  zoom: boolean;
  keywords: string[];
}

export interface Usage {
  model: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number;
}

// O modelo só decide o que exige julgamento. Tempos formatados, legenda social,
// custos e configs de render são calculados em código (zero tokens de saída gastos nisso).
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cortes"],
  properties: {
    cortes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start_seconds", "end_seconds", "score_viral", "gancho_impacto", "titulo_corte", "layout_type", "zoom_on_emphasis", "palavras_destaque"],
        properties: {
          start_seconds: { type: "number" },
          end_seconds: { type: "number" },
          score_viral: { type: "integer" },
          gancho_impacto: { type: "string" },
          titulo_corte: { type: "string" },
          layout_type: { type: "string", enum: ["single_speaker", "split_screen", "screen_share_focus"] },
          zoom_on_emphasis: { type: "boolean" },
          palavras_destaque: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

function systemPrompt(ch: Channel): string {
  return `Você é o motor de curadoria de uma plataforma de cortes virais para TikTok, YouTube Shorts e Instagram Reels.

<canal>
Nome: ${ch.name}
Nicho / posicionamento: ${ch.niche}
Tom de voz: ${ch.tone}
${ch.extra_instructions ? `Instruções adicionais: ${ch.extra_instructions}` : ""}
</canal>

Você recebe a transcrição de um vídeo longo. Cada linha é "SEGUNDO_INICIAL|texto".
Selecione os trechos com maior potencial de engajamento para esse canal e esse público.

Critérios de um bom corte:
- Duração entre ${ch.min_duration} e ${ch.max_duration} segundos.
- Começo, meio e fim claros: abre com um gancho que se sustenta sem contexto prévio (pergunta, provocação, tese forte), desenvolve o argumento e fecha numa conclusão ou frase de efeito. Nunca comece no meio de uma frase nem termine antes da conclusão do raciocínio.
- Prefira teses contundentes, dados concretos, confrontos de ideias e momentos que gerem comentário e compartilhamento.
- Cortes não podem se sobrepor.

Para cada corte:
- start_seconds / end_seconds: use os segundos das linhas; o sistema ajusta ao limite exato da frase.
- score_viral: 0 a 100, calibrado (90+ só para trechos excepcionais).
- gancho_impacto: uma frase explicando por que o trecho prende a atenção.
- titulo_corte: título em CAIXA ALTA, até 70 caracteres, chamativo mas fiel ao que é dito (sem inventar fatos).
- layout_type: "single_speaker" quando uma pessoa domina o trecho; "split_screen" quando há troca direta entre duas pessoas (debate, entrevista com réplica); "screen_share_focus" quando o falante comenta tela, slide, gráfico ou vídeo.
- zoom_on_emphasis: true quando há picos de ênfase que merecem punch-in.
- palavras_destaque: 4 a 10 palavras exatamente como aparecem na transcrição, as de maior impacto (para destacar na legenda).

Retorne até ${ch.clips_target} cortes, do maior para o menor score. Se o vídeo não tiver material bom, retorne menos.`;
}

export async function analyze(ch: Channel, t: Transcript, title: string): Promise<{ cuts: CutProposal[]; usage: Usage }> {
  const model = ch.model || config.defaultModel;
  const effort = (ch.effort || config.defaultEffort) as Effort;

  const message = await client.beta.messages
    .stream({
      model,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      // System estável por canal → cache entre vídeos do mesmo canal.
      system: [{ type: "text", text: systemPrompt(ch), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Título do vídeo: ${title}\n\n<transcricao>\n${compactTranscript(t)}\n</transcricao>` }],
    })
    .finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Modelo recusou a análise (${message.stop_details?.category ?? "sem categoria"})`);
  }
  if (message.stop_reason === "max_tokens") throw new Error("Resposta da IA truncada (max_tokens)");

  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(text) as {
    cortes: {
      start_seconds: number;
      end_seconds: number;
      score_viral: number;
      gancho_impacto: string;
      titulo_corte: string;
      layout_type: Layout;
      zoom_on_emphasis: boolean;
      palavras_destaque: string[];
    }[];
  };

  const cuts: CutProposal[] = [];
  for (const c of parsed.cortes) {
    const snapped = snapToSentences(t, c.start_seconds, c.end_seconds, ch.min_duration, ch.max_duration);
    if (!snapped) continue;
    if (cuts.some((o) => snapped.start_s < o.end_s && snapped.end_s > o.start_s)) continue;
    cuts.push({
      ...snapped,
      score: Math.max(0, Math.min(100, Math.round(c.score_viral))),
      hook: c.gancho_impacto,
      title: c.titulo_corte.toUpperCase(),
      layout: c.layout_type,
      zoom: c.zoom_on_emphasis,
      keywords: c.palavras_destaque,
    });
  }
  cuts.sort((a, b) => b.score - a.score);

  const u = message.usage;
  const served = message.model || model;
  const usage: Usage = {
    model: served,
    tokens_in: u.input_tokens,
    tokens_out: u.output_tokens,
    tokens_cache_read: u.cache_read_input_tokens ?? 0,
    tokens_cache_write: u.cache_creation_input_tokens ?? 0,
    cost_usd: 0,
  };
  usage.cost_usd = costOf(usage);
  return { cuts, usage };
}

export function costOf(u: Omit<Usage, "cost_usd">): number {
  const p = PRICING[u.model] ?? PRICING[config.defaultModel];
  if (!p) return 0;
  const usd = (u.tokens_in * p.input + u.tokens_out * p.output + u.tokens_cache_read * p.cacheRead + u.tokens_cache_write * p.cacheWrite) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Ajusta [start, end] aos limites de frase mais próximos e força a duração no intervalo permitido.
 * Retorna null se não houver frase utilizável.
 */
export function snapToSentences(t: Transcript, start: number, end: number, minDur: number, maxDur: number) {
  const S = t.sentences;
  if (!S.length) return null;
  const nearest = (time: number, key: "s" | "e") =>
    S.reduce((best, s, i) => (Math.abs(s[key] - time) < Math.abs(S[best][key] - time) ? i : best), 0);

  const a = nearest(start, "s");
  let b = Math.max(a, nearest(end, "e"));
  // Encurta até caber no máximo; alonga até o mínimo.
  while (b > a && S[b].e - S[a].s > maxDur) b--;
  while (b < S.length - 1 && S[b].e - S[a].s < minDur && S[b + 1].e - S[a].s <= maxDur) b++;
  const dur = S[b].e - S[a].s;
  if (dur < minDur * 0.8 || dur > maxDur + 5) return null;

  const words = t.words;
  const prevEnd = S[a].i0 > 0 ? words[S[a].i0 - 1].e : 0;
  const nextStart = S[b].i1 < words.length - 1 ? words[S[b].i1 + 1].s : S[b].e + 1;
  return {
    start_s: round2(Math.max(prevEnd, S[a].s - 0.15)),
    end_s: round2(Math.min(nextStart, S[b].e + 0.35)),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
