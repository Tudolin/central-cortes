import type { Word } from "./transcribe.ts";

export interface SubtitleOptions {
  font: string;
  highlightColor: string; // #RRGGBB
  maxWords: number;
  align: number;
  marginV: number;
}

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** #RRGGBB → &H00BBGGRR& (ordem de cor do ASS). */
const assColor = (hex: string) => {
  const h = hex.replace("#", "").padStart(6, "0");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** Palavras do corte com tempos relativos ao início do corte. */
export function clipWords(words: Word[], start: number, end: number): Word[] {
  return words.filter((w) => w.e > start && w.s < end).map((w) => ({ w: w.w, s: Math.max(0, w.s - start), e: Math.min(end, w.e) - start }));
}

/** Instantes (relativos) das palavras-chave, espaçados ≥ 2.5 s — usados para o punch-in de zoom. */
export function emphasisTimes(words: Word[], keywords: string[], max = 8): number[] {
  const keys = new Set(keywords.map(norm).filter(Boolean));
  const times: number[] = [];
  for (const w of words) {
    if (keys.has(norm(w.w)) && (!times.length || w.s - times.at(-1)! >= 2.5)) times.push(w.s);
    if (times.length >= max) break;
  }
  return times;
}

/**
 * Legenda estilo Hormozi / Dark Bauhaus: blocos de 2–4 palavras em caixa alta, contorno preto pesado,
 * palavra falada em destaque (cor + pop de escala) e palavras-chave sempre na cor de destaque.
 */
export function buildAss(words: Word[], keywords: string[], o: SubtitleOptions): string {
  const keys = new Set(keywords.map(norm).filter(Boolean));
  const hi = assColor(o.highlightColor);

  const chunks: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur.at(-1);
    if (cur.length && (cur.length >= o.maxWords || w.s - prev!.e > 0.6 || /[.!?…,;:]$/.test(prev!.w))) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);

  const events: string[] = [];
  chunks.forEach((chunk, ci) => {
    const nextChunkStart = chunks[ci + 1]?.[0].s ?? Infinity;
    const chunkEnd = Math.min(chunk.at(-1)!.e + 0.25, nextChunkStart);
    chunk.forEach((active, k) => {
      const start = active.s;
      const end = k < chunk.length - 1 ? chunk[k + 1].s : chunkEnd;
      if (end <= start) return;
      const text = chunk
        .map((w) => {
          const t = w.w.toUpperCase().replace(/[{}\\]/g, "");
          if (w === active) return `{\\c${hi}\\fscx112\\fscy112}${t}{\\r}`;
          if (keys.has(norm(w.w))) return `{\\c${hi}}${t}{\\r}`;
          return t;
        })
        .join(" ");
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cut,,0,0,0,,${text}`);
    });
  });

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cut,${o.font},84,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H99000000&,-1,0,0,0,100,100,1,0,1,6,3,${o.align},80,80,${o.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}
