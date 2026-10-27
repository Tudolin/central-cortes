import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { config, PRICING, type Effort } from "../config.ts";
import { parseJson, type Brand, type Template } from "../brand.ts";
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
  teaser_start: number;
  teaser_end: number;
  speaker_name: string;
  speaker_role: string;
  pillar: string;
  hashtags: string;
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
const pillarsOf = (ch: Channel) => (parseJson<Brand>(ch.brand, {}).pillars ?? []).filter(Boolean);

/** Schema da resposta; o pilar só existe (e só aceita os valores do canal) quando o canal define pilares. */
function outputSchema(pillars: string[]) {
  const s = structuredClone(OUTPUT_SCHEMA) as unknown as {
    properties: { cortes: { items: { required: string[]; properties: Record<string, unknown> } } };
  };
  if (pillars.length) {
    s.properties.cortes.items.properties.pilar = { type: "string", enum: pillars };
    s.properties.cortes.items.required.push("pilar");
  }
  return s;
}

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
        required: [
          "start_seconds", "end_seconds", "score_viral", "gancho_impacto", "titulo_corte", "layout_type", "zoom_on_emphasis", "palavras_destaque",
          "teaser_start_seconds", "teaser_end_seconds", "falante_nome", "falante_cargo", "hashtags_assunto",
        ],
        properties: {
          start_seconds: { type: "number" },
          end_seconds: { type: "number" },
          score_viral: { type: "integer" },
          gancho_impacto: { type: "string" },
          titulo_corte: { type: "string" },
          layout_type: { type: "string", enum: ["single_speaker", "split_screen", "screen_share_focus"] },
          zoom_on_emphasis: { type: "boolean" },
          palavras_destaque: { type: "array", items: { type: "string" } },
          teaser_start_seconds: { type: "number" },
          teaser_end_seconds: { type: "number" },
          falante_nome: { type: "string" },
          falante_cargo: { type: "string" },
          hashtags_assunto: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** Limites do modelo de corte (ou do canal, sem modelo). */
const limits = (ch: Channel, tpl: Template | null) => ({ min: tpl?.min_duration ?? ch.min_duration, max: tpl?.max_duration ?? ch.max_duration });

function systemPrompt(ch: Channel, tpl: Template | null): string {
  const { min, max } = limits(ch, tpl);
  const layoutRule = tpl && tpl.layout !== "auto"
    ? `- layout_type: este formato usa sempre "${tpl.layout}".`
    : `- layout_type: "single_speaker" quando uma pessoa domina o trecho; "split_screen" quando há troca direta entre duas pessoas (debate, entrevista com réplica); "screen_share_focus" quando o falante comenta tela, slide, gráfico ou vídeo.`;
  return `Você é o motor de curadoria de uma plataforma de cortes virais para TikTok, YouTube Shorts e Instagram Reels.

<canal>
Nome: ${ch.name}
Nicho / posicionamento: ${ch.niche}
Tom de voz: ${ch.tone}
${ch.extra_instructions ? `Instruções adicionais: ${ch.extra_instructions}` : ""}
</canal>
${tpl ? `
<formato nome="${tpl.name}">
${tpl.instructions}
</formato>
` : ""}

Você recebe a transcrição de um vídeo longo. Cada linha é "SEGUNDO_INICIAL|texto".
Selecione os trechos com maior potencial de engajamento para esse canal e esse público.

Critérios de um bom corte:
- Duração entre ${min} e ${max} segundos.
- Começo, meio e fim claros: abre com um gancho que se sustenta sem contexto prévio (pergunta, provocação, tese forte), desenvolve o argumento e fecha numa conclusão ou frase de efeito. Nunca comece no meio de uma frase nem termine antes da conclusão do raciocínio.
- Prefira teses contundentes, dados concretos, confrontos de ideias e momentos que gerem comentário e compartilhamento.
- Cortes não podem se sobrepor.

Para cada corte:
- start_seconds / end_seconds: use os segundos das linhas; o sistema ajusta ao limite exato da frase.
- score_viral: 0 a 100, calibrado (90+ só para trechos excepcionais).
- gancho_impacto: uma frase explicando por que o trecho prende a atenção.
${ch.title_style === "sentence"
    ? "- titulo_corte: o gancho reescrito como título em caixa normal (maiúscula só no início e em nomes próprios, nunca o título inteiro em caixa alta), até 70 caracteres, no máximo um emoji, fiel ao que é dito (sem inventar fatos)."
    : "- titulo_corte: título em CAIXA ALTA, até 70 caracteres, chamativo mas fiel ao que é dito (sem inventar fatos)."}
${layoutRule}
- zoom_on_emphasis: true quando há picos de ênfase que merecem punch-in.
- palavras_destaque: 4 a 10 palavras exatamente como aparecem na transcrição, as de maior impacto (para destacar na legenda).
- teaser_start_seconds / teaser_end_seconds: a frase mais forte DENTRO do corte, de 2 a 6 segundos, que funcionaria como chamada repetida no início do vídeo. Use 0 e 0 se nenhuma frase se sustenta sozinha.
- hashtags_assunto: 1 ou 2 hashtags do assunto específico do corte, com #, minúsculas e sem acento (ex.: "#hipertrofia").
${pillarsOf(ch).length ? `- pilar: o pilar de conteúdo do corte, um destes: ${pillarsOf(ch).join(", ")}.\n` : ""}- falante_nome / falante_cargo: nome e cargo/função de quem fala no trecho, só se forem ditos explicitamente na transcrição ou no título do vídeo (ex.: "Fernando Haddad" / "Ministro da Fazenda"). Nunca deduza nem invente; na dúvida, use "".

Retorne até ${ch.clips_target} cortes, do maior para o menor score. Se o vídeo não tiver material bom, retorne menos.`;
}

type Parsed = {
  cortes: {
    start_seconds: number;
    end_seconds: number;
    score_viral: number;
    gancho_impacto: string;
    titulo_corte: string;
    layout_type: Layout;
    zoom_on_emphasis: boolean;
    palavras_destaque: string[];
    teaser_start_seconds: number;
    teaser_end_seconds: number;
    falante_nome: string;
    falante_cargo: string;
    hashtags_assunto: string[];
    pilar?: string;
  }[];
};

/** Prefixo do campo model dos jobs analisados pela IA local (o painel mostra a tag "IA local"). */
export const LOCAL_PREFIX = "local/";

/** Erros do Claude que a IA local cobre: sem crédito, sem chave, limite de uso, sobrecarga. */
function claudeUnavailable(e: unknown) {
  const status = (e as { status?: number }).status;
  return [401, 402, 403, 429, 529].includes(status ?? 0)
    || /credit balance|billing|quota|api[_ ]?key|overloaded|rate.?limit/i.test((e as Error).message ?? "");
}

export async function analyze(
  ch: Channel, tpl: Template | null, t: Transcript, title: string, onProgress?: (detail: string) => void,
): Promise<{ cuts: CutProposal[]; usage: Usage }> {
  if (config.localAi === "always") return analyzeLocal(ch, tpl, t, title, onProgress);
  try {
    return await analyzeClaude(ch, tpl, t, title);
  } catch (e) {
    if (config.localAi === "off" || !claudeUnavailable(e)) throw e;
    console.warn(`[analyze] Claude indisponível (${(e as Error).message.slice(0, 120)}); usando IA local`);
    try {
      return await analyzeLocal(ch, tpl, t, title, onProgress);
    } catch (le) {
      throw new Error(`Claude indisponível (${(e as Error).message.slice(0, 150)}) e a IA local falhou: ${(le as Error).message}`);
    }
  }
}

async function analyzeClaude(ch: Channel, tpl: Template | null, t: Transcript, title: string): Promise<{ cuts: CutProposal[]; usage: Usage }> {
  const model = ch.model || config.defaultModel;
  const effort = (ch.effort || config.defaultEffort) as Effort;

  const message = await client.beta.messages
    .stream({
      model,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema: outputSchema(pillarsOf(ch)) } },
      // System estável por canal → cache entre vídeos do mesmo canal.
      system: [{ type: "text", text: systemPrompt(ch, tpl), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Título do vídeo: ${title}\n\n<transcricao>\n${compactTranscript(t)}\n</transcricao>` }],
    })
    .finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Modelo recusou a análise (${message.stop_details?.category ?? "sem categoria"})`);
  }
  if (message.stop_reason === "max_tokens") throw new Error("Resposta da IA truncada (max_tokens)");

  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const cuts = toCuts(ch, tpl, t, JSON.parse(text) as Parsed);

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

// ---------- IA local (Ollama) ----------
// Um modelo de 8B na GPU de 8 GB não comporta a transcrição de um vídeo longo de uma vez:
// o vídeo é dividido em janelas de ~20 min (com sobreposição para não perder cortes na fronteira),
// cada janela pede uma parte dos cortes e o resultado passa pelo mesmo ajuste de frases do Claude.

const WINDOW_S = 20 * 60;
const OVERLAP_S = 2 * 60;

const ollamaUp = () => fetch(`${config.ollamaUrl}/api/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

/**
 * Sobe o servidor do Ollama se não estiver rodando. O app de bandeja do Ollama desiste antes de a
 * detecção da GPU terminar (~10 s nesta máquina), então o worker inicia o `ollama serve` ele mesmo.
 */
async function ensureOllama() {
  if (await ollamaUp()) return;
  if (!existsSync(config.ollamaBin)) throw new Error(`Ollama não instalado (${config.ollamaBin})`);
  // Sem detached: o servidor herda o console oculto do worker e os runners que ele abre a cada
  // modelo carregado também (detached deixa o serve sem console e cada runner pisca uma janela).
  // Ele morre junto com o worker; o próximo vídeo sobe de novo.
  spawn(config.ollamaBin, ["serve"], { stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ollamaUp()) return;
  }
  throw new Error("o servidor do Ollama não subiu em 60 s");
}

async function ollamaChat(system: string, user: string, schema: unknown) {
  const r = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.localModel,
      stream: false,
      think: false,
      format: schema,
      keep_alive: "2m", // libera a GPU logo depois (o render usa NVENC)
      options: { num_ctx: 16384, temperature: 0.3 },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(20 * 60_000),
  }).catch((e) => {
    throw new Error(`Ollama não respondeu em ${config.ollamaUrl} (${(e as Error).message})`);
  });
  const data = (await r.json().catch(() => ({}))) as { message?: { content?: string }; error?: string; prompt_eval_count?: number; eval_count?: number };
  if (!r.ok) throw new Error(`Ollama: ${data.error ?? `HTTP ${r.status}`}`);
  return { text: data.message?.content ?? "", tokensIn: data.prompt_eval_count ?? 0, tokensOut: data.eval_count ?? 0 };
}

export async function analyzeLocal(
  ch: Channel, tpl: Template | null, t: Transcript, title: string, onProgress?: (detail: string) => void,
): Promise<{ cuts: CutProposal[]; usage: Usage }> {
  const lines = compactTranscript(t).split("\n").filter(Boolean);
  const total = Math.max(1, t.sentences.at(-1)?.e ?? 1);
  const windows: string[][] = [];
  for (let from = 0; from < total; from += WINDOW_S - OVERLAP_S) {
    const w = lines.filter((l) => {
      const s = Number(l.slice(0, l.indexOf("|")));
      return s >= from && s < from + WINDOW_S;
    });
    if (w.length) windows.push(w);
    if (from + WINDOW_S >= total) break;
  }
  const perWindow = Math.max(2, Math.ceil((ch.clips_target / windows.length) * 1.5));
  const system = systemPrompt({ ...ch, clips_target: perWindow }, tpl)
    + "\n\nVocê está vendo só um trecho do vídeo: use os segundos exatamente como aparecem nas linhas. Responda apenas com o JSON pedido.";

  await ensureOllama();
  const all: Parsed["cortes"] = [];
  let tokensIn = 0, tokensOut = 0;
  for (const [i, w] of windows.entries()) {
    onProgress?.(`IA local (${config.localModel}): parte ${i + 1}/${windows.length}`);
    const res = await ollamaChat(system, `Título do vídeo: ${title}\n\n<transcricao>\n${w.join("\n")}\n</transcricao>`, outputSchema(pillarsOf(ch)));
    tokensIn += res.tokensIn;
    tokensOut += res.tokensOut;
    try {
      all.push(...(JSON.parse(res.text) as Parsed).cortes);
    } catch {
      console.warn(`[analyze] IA local: resposta inválida na parte ${i + 1}, ignorada`);
    }
  }
  // Os melhores primeiro: na sobreposição entre janelas, toCuts mantém o de maior score.
  all.sort((a, b) => b.score_viral - a.score_viral);
  const cuts = toCuts(ch, tpl, t, { cortes: all }).slice(0, ch.clips_target);
  if (!cuts.length) throw new Error("a IA local não encontrou cortes utilizáveis");
  return {
    cuts,
    usage: { model: LOCAL_PREFIX + config.localModel, tokens_in: tokensIn, tokens_out: tokensOut, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 },
  };
}

/** Resposta da IA → cortes ajustados aos limites de frase, sem sobreposição, do maior score para o menor. */
function toCuts(ch: Channel, tpl: Template | null, t: Transcript, parsed: Parsed): CutProposal[] {
  const { min, max } = limits(ch, tpl);
  const cuts: CutProposal[] = [];
  for (const c of parsed.cortes) {
    const snapped = snapToSentences(t, c.start_seconds, c.end_seconds, min, max);
    if (!snapped) continue;
    if (cuts.some((o) => snapped.start_s < o.end_s && snapped.end_s > o.start_s)) continue;
    cuts.push({
      ...snapped,
      score: Math.max(0, Math.min(100, Math.round(c.score_viral))),
      hook: c.gancho_impacto,
      title: ch.title_style === "sentence" ? c.titulo_corte.trim() : c.titulo_corte.toUpperCase(),
      layout: tpl && tpl.layout !== "auto" ? tpl.layout : c.layout_type,
      zoom: c.zoom_on_emphasis,
      keywords: c.palavras_destaque,
      ...snapTeaser(t, c.teaser_start_seconds, c.teaser_end_seconds, snapped.start_s, snapped.end_s),
      speaker_name: c.falante_nome.trim().slice(0, 60),
      speaker_role: c.falante_cargo.trim().slice(0, 80),
      pillar: c.pilar ?? "",
      hashtags: c.hashtags_assunto.slice(0, 2).map((h) => "#" + h.replace(/^#/, "").replace(/\s+/g, "")).join(" "),
    });
  }
  cuts.sort((a, b) => b.score - a.score);
  return cuts;
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

/** Teaser ajustado às palavras (2–8 s, dentro do corte); 0/0 quando não serve. */
function snapTeaser(t: Transcript, start: number, end: number, cutStart: number, cutEnd: number) {
  const none = { teaser_start: 0, teaser_end: 0 };
  if (!(end > start)) return none;
  const inside = t.words.filter((w) => w.s >= Math.max(cutStart, start - 0.4) && w.e <= Math.min(cutEnd, end + 0.4));
  if (!inside.length) return none;
  const s = inside[0].s;
  const e = inside.at(-1)!.e;
  if (e - s < 1.5 || e - s > 8) return none;
  return { teaser_start: round2(Math.max(cutStart, s - 0.1)), teaser_end: round2(Math.min(cutEnd, e + 0.2)) };
}
