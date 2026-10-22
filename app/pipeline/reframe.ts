import type { Layout } from "../db.ts";
import type { Face, FaceSample } from "./faces.ts";

/** Resolução de saída (9:16). Coordenadas de legenda/faixa são sempre em 1080x1920 (PlayRes do ASS). */
export interface Out {
  w: number;
  h: number;
}

export type LayoutUsed = Layout | "fit";

export interface ReframePlan {
  layout: LayoutUsed;
  /** Filtergraph que lê [0:v] e produz [base] no tamanho `out`. */
  graph: string;
  /** Posição das legendas (ASS): alinhamento numpad e margem vertical. */
  subAlign: number;
  subMarginV: number;
  /** Centro vertical da faixa de título (coordenadas 1080x1920), escolhido para não cobrir rostos. */
  bannerY: number;
  canZoom: boolean;
  /** Fator de ampliação da imagem principal (>1 = recorte menor que a saída → aplicar nitidez). */
  upscale: number;
}

interface Cluster {
  cx: number;
  cy: number;
  h: number;
  presence: number; // fração das amostras em que aparece
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/** Agrupa rostos por posição horizontal → "falantes" estáveis no enquadramento. */
function clusterFaces(samples: FaceSample[], W: number): Cluster[] {
  const pts: { f: Face; i: number }[] = [];
  samples.forEach((s, i) => s.faces.forEach((f) => f.w >= W * 0.03 && pts.push({ f, i })));
  pts.sort((a, b) => a.f.cx - b.f.cx);
  const groups: (typeof pts)[] = [];
  for (const p of pts) {
    const g = groups.at(-1);
    if (g && p.f.cx - g.at(-1)!.f.cx < W * 0.08) g.push(p);
    else groups.push([p]);
  }
  return groups
    .map((g) => ({
      cx: median(g.map((p) => p.f.cx)),
      cy: median(g.map((p) => p.f.cy)),
      h: median(g.map((p) => p.f.h)),
      presence: new Set(g.map((p) => p.i)).size / Math.max(1, samples.length),
    }))
    .sort((a, b) => b.presence - a.presence);
}

/**
 * Decide o layout final cruzando a sugestão da IA (dinâmica do texto) com o que de fato está na imagem,
 * e gera o filtergraph correspondente.
 */
export function planReframe(requested: Layout, samples: FaceSample[], W: number, H: number, out: Out): ReframePlan {
  const clusters = clusterFaces(samples, W);
  const present = clusters.filter((c) => c.presence >= 0.2);
  const portraitSource = W / H < 0.7;

  if (!present.length || portraitSource) return fitPlan(W, out);
  if (requested === "split_screen") {
    const pair = clusters.filter((c) => c.presence >= 0.3).slice(0, 2);
    if (pair.length === 2) return splitPlan(pair.sort((a, b) => a.cx - b.cx), W, H, out);
  }
  if (requested === "screen_share_focus") return screenPlan(present[0], W, H, out);
  return singlePlan(samples, W, H, out);
}

/** Recorte 9:16 que segue o rosto com zona morta (evita "câmera nervosa") e cortes secos em trocas de plano. */
function singlePlan(samples: FaceSample[], W: number, H: number, out: Out): ReframePlan {
  const cw = even(Math.min(W, (H * 9) / 16));
  const maxX = W - cw;
  const deadZone = cw * 0.12;

  let target: number | null = null;
  let cam: number | null = null;
  const points: [number, number][] = []; // (t, x) linear por partes
  for (const s of samples) {
    const faces = s.faces.filter((f) => f.w >= W * 0.03);
    if (faces.length) {
      const prev = target;
      const near: Face[] = prev === null ? [] : faces.filter((f) => Math.abs(f.cx - prev) < W * 0.15);
      const pick = (near.length ? near : faces).reduce((a: Face, b: Face) => (b.w * b.h > a.w * a.h ? b : a));
      target = pick.cx;
    }
    if (target === null) continue;
    const x = clamp(target - cw / 2, 0, maxX);
    if (cam === null) {
      cam = x;
      points.push([0, x]);
    } else if (Math.abs(x - cam) > deadZone) {
      const hardCut = Math.abs(x - cam) > W * 0.25;
      points.push([s.t, cam], [s.t + (hardCut ? 0.04 : 0.5), x]);
      cam = x;
    }
  }
  if (!points.length) points.push([0, maxX / 2]);

  return {
    layout: "single_speaker",
    graph: `[0:v]crop=${cw}:${even(H)}:x='${piecewise(points)}':y=0,scale=${out.w}:${out.h}:flags=lanczos,setsar=1[base]`,
    subAlign: 2,
    subMarginV: 500,
    bannerY: 330, // acima do rosto, que fica no terço central
    canZoom: true,
    upscale: out.h / H,
  };
}

function splitPlan([a, b]: Cluster[], W: number, H: number, out: Out): ReframePlan {
  let rhMin = H;
  const region = (c: Cluster) => {
    const rh = even(clamp(c.h * 3.2, H * 0.45, H));
    const rw = even(Math.min(W, (rh * 9) / 8));
    rhMin = Math.min(rhMin, rh);
    return `crop=${rw}:${rh}:${Math.round(clamp(c.cx - rw / 2, 0, W - rw))}:${Math.round(clamp(c.cy - rh * 0.42, 0, H - rh))},scale=${out.w}:${even(out.h / 2)}:flags=lanczos,setsar=1`;
  };
  const top = region(a);
  const bot = region(b);
  return {
    layout: "split_screen",
    graph: `[0:v]split=2[sa][sb];[sa]${top}[top];[sb]${bot}[bot];[top][bot]vstack[base]`,
    // Faixa de título na emenda entre os dois; legendas descem para a base.
    subAlign: 2,
    subMarginV: 230,
    bannerY: 960,
    canZoom: false,
    upscale: out.h / 2 / rhMin,
  };
}

function screenPlan(speaker: Cluster, W: number, H: number, out: Out): ReframePlan {
  const k = out.h / 1920;
  const topH = even(810 * k);
  const slideH = even((out.w * H) / W);
  const rh = even(clamp(speaker.h * 3, H * 0.25, H));
  const rw = even(Math.min(W, (rh * out.w) / topH));
  const x = Math.round(clamp(speaker.cx - rw / 2, 0, W - rw));
  const y = Math.round(clamp(speaker.cy - rh * 0.42, 0, H - rh));
  return {
    layout: "screen_share_focus",
    graph:
      `[0:v]split=3[ba][bb][bc];` +
      `[ba]scale=${out.w}:${out.h}:force_original_aspect_ratio=increase,crop=${out.w}:${out.h},boxblur=24:2,eq=brightness=-0.3,setsar=1[bg];` +
      `[bb]crop=${rw}:${rh}:${x}:${y},scale=${out.w}:${topH}:flags=lanczos,setsar=1[pip];` +
      `[bc]scale=${out.w}:${slideH}:flags=lanczos,setsar=1[slide];` +
      `[bg][pip]overlay=0:0[t1];[t1][slide]overlay=0:${even(topH + 30 * k)}[base]`,
    subAlign: 2,
    subMarginV: 230,
    bannerY: 830, // entre o falante e a tela
    canZoom: false,
    upscale: topH / rh,
  };
}

/** Sem rosto confiável: vídeo inteiro centralizado sobre fundo desfocado. */
function fitPlan(W: number, out: Out): ReframePlan {
  return {
    layout: "fit",
    graph:
      `[0:v]split=2[fa][fb];` +
      `[fa]scale=${out.w}:${out.h}:force_original_aspect_ratio=increase,crop=${out.w}:${out.h},boxblur=24:2,eq=brightness=-0.3,setsar=1[bg];` +
      `[fb]scale=${out.w}:${out.h}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
    subAlign: 2,
    subMarginV: 420,
    bannerY: 380,
    canZoom: true,
    upscale: out.w / W,
  };
}

/** Expressão ffmpeg para interpolação linear por partes em função de t. */
function piecewise(points: [number, number][]): string {
  const p = points.slice(-60).map(([t, x]) => [Math.round(t * 100) / 100, Math.round(x)] as const);
  let expr = String(p.at(-1)![1]);
  for (let i = p.length - 2; i >= 0; i--) {
    const [t0, x0] = p[i];
    const [t1, x1] = p[i + 1];
    const seg = x0 === x1 || t1 <= t0 ? `${x0}` : `${x0}+${x1 - x0}*(t-${t0})/${Math.round((t1 - t0) * 100) / 100}`;
    expr = `if(lt(t,${t1}),${seg},${expr})`;
  }
  return expr;
}
