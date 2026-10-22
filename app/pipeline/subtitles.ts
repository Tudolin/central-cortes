import type { Word } from "./transcribe.ts";

export interface SubtitleOptions {
  font: string;
  highlightColor: string; // #RRGGBB
  maxWords: number;
  align: number;
  marginV: number;
  banner?: BannerOptions;
}

export interface BannerOptions {
  title: string;
  font: string;
  color: string; // fundo da faixa
  textColor: string;
  centerY: number; // centro vertical da faixa no quadro 1080x1920
  duration: number;
  seed: number; // borda "pincelada" determinística por corte
}

/** Quebra o título em linhas equilibradas de até `max` caracteres. */
function wrapTitle(title: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of title.trim().split(/\s+/)) {
    if (cur && (cur + " " + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Faixa de título estilo "corte de podcast": retângulo vermelho com borda irregular de pincel,
 * levemente inclinado, texto amarelo em caixa alta com contorno preto. Fica o vídeo todo, então
 * qualquer quadro usado como capa (TikTok, Shorts, Telegram) já mostra o título.
 */
function bannerEvents(b: BannerOptions): string[] {
  const text = b.title.toUpperCase().replace(/[{}\\]/g, "");
  // Linhas equilibradas (sem palavra órfã): menor limite que mantém o número mínimo de linhas.
  const balanced = (max: number) => {
    const n = wrapTitle(text, max).length;
    let lim = max;
    while (lim > 8 && wrapTitle(text, lim - 1).length === n) lim--;
    return wrapTitle(text, lim);
  };
  let size = 108;
  let lines = balanced(15);
  if (lines.length > 3) {
    size = 86;
    lines = balanced(21);
  }
  const lineH = size * 1.0;
  const h = Math.round(lines.length * lineH + 50);
  // Largura acompanha a linha mais longa (Impact ≈ 0,5 em por caractere), como nas capas de corte.
  const textW = Math.max(...lines.map((l) => l.length)) * size * 0.5;
  const w = Math.round(Math.min(960, Math.max(560, textW + 90)));
  const x0 = Math.round(540 - w / 2);
  const x1 = x0 + w;
  const y0 = Math.round(b.centerY - h / 2);
  const y1 = y0 + h;

  // Pseudo-aleatório determinístico (mesmo corte → mesma borda em re-renders).
  let s = b.seed * 9301 + 49297;
  const rnd = (amp: number) => {
    s = (s * 9301 + 49297) % 233280;
    return Math.round((s / 233280 - 0.5) * 2 * amp);
  };
  const pts: [number, number][] = [];
  for (let x = x0; x <= x1; x += 46) pts.push([x, y0 + rnd(7)]);
  for (let y = y0 + 30; y < y1; y += 30) pts.push([x1 + rnd(9), y]);
  for (let x = x1; x >= x0; x -= 46) pts.push([x, y1 + rnd(7)]);
  for (let y = y1 - 30; y > y0; y -= 30) pts.push([x0 + rnd(9), y]);
  const shape = `m ${pts[0][0]} ${pts[0][1]} l ${pts.slice(1).map(([x, y]) => `${x} ${y}`).join(" ")}`;

  const rot = `\\org(540,${Math.round(b.centerY)})\\frz2`;
  const end = assTime(b.duration + 1);
  return [
    `Dialogue: 0,0:00:00.00,${end},BannerBox,,0,0,0,,{\\an7\\pos(0,0)${rot}\\c${assColor(b.color)}\\bord0\\shad8\\4a&H80&\\p1}${shape}{\\p0}`,
    `Dialogue: 1,0:00:00.00,${end},BannerText,,0,0,0,,{\\an5\\pos(540,${Math.round(b.centerY + 4)})${rot}\\fs${size}}${lines.join("\\N")}`,
  ];
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
      events.push(`Dialogue: 2,${assTime(start)},${assTime(end)},Cut,,0,0,0,,${text}`);
    });
  });
  if (o.banner) events.unshift(...bannerEvents(o.banner));
  const bannerFont = o.banner?.font ?? o.font;
  const bannerText = assColor(o.banner?.textColor ?? "#FFD700");

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cut,${o.font},84,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H99000000&,-1,0,0,0,100,100,1,0,1,6,3,${o.align},80,80,${o.marginV},1
Style: BannerBox,${bannerFont},20,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,0,8,7,0,0,0,1
Style: BannerText,${bannerFont},86,${bannerText},${bannerText},&H00000000&,&H00000000&,0,0,0,0,100,100,1,0,1,5,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}
