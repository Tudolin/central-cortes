import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ctaStart, type Insets, type RenderSpec, type SafeZone } from "../brand.ts";
import { config } from "../config.ts";
import type { Channel, Clip } from "../db.ts";
import { exec } from "../proc.ts";
import { detectFaces, type FaceSample } from "./faces.ts";
import { landscapePlan, planReframe, type LayoutUsed, type Out } from "./reframe.ts";
import { probeVideo } from "./source.ts";
import { buildAss, clipWords, emphasisTimes } from "./subtitles.ts";
import type { Transcript, Word } from "./transcribe.ts";

export type ClipArtifact = "mp4" | "jpg" | "ass" | "proxy" | "preview";
export const clipFile = (dir: string, clipId: number, ext: ClipArtifact) =>
  join(dir, ext === "proxy" || ext === "preview" ? `clip-${clipId}.${ext}.mp4` : `clip-${clipId}.${ext}`);

const OUTS: Record<RenderSpec["aspect"], Out> = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 } };

/**
 * Qualidade de entrega: bitrate alto de propósito. YouTube e TikTok recomprimem o upload, e um
 * arquivo de ~2 Mbps (o que o CRF 21 gerava em cabeça falante) vira papa depois da segunda compressão.
 * NVENC usa presets p1–p7 e -cq no lugar de -crf.
 */
function videoCodecArgs(): string[] {
  const { vcodec, preset, crf } = config.render;
  if (vcodec.includes("nvenc")) {
    return [
      "-c:v", vcodec, "-preset", /^p[1-7]$/.test(preset) ? preset : "p6", "-tune", "hq", "-profile:v", "high",
      "-rc", "vbr", "-cq", crf, "-b:v", "10M", "-maxrate", "16M", "-bufsize", "32M",
      "-spatial-aq", "1", "-temporal-aq", "1", "-bf", "3",
    ];
  }
  return ["-c:v", vcodec, "-preset", preset, "-crf", crf, "-profile:v", "high", "-maxrate", "16M", "-bufsize", "32M"];
}

// ---------- Zonas seguras (1080x1920): onde a interface de cada app cobre o vídeo ----------

const ZONES: Record<SafeZone, Insets> = {
  tiktok: { top: 130, bottom: 420, left: 40, right: 140 }, // legenda + botões à direita
  youtube: { top: 120, bottom: 380, left: 40, right: 120 },
  reels: { top: 220, bottom: 420, left: 40, right: 110 },
};

function safeInsets(spec: RenderSpec): Insets {
  if (spec.aspect === "16:9") return { top: 50, bottom: 50, left: 60, right: 60 };
  if (spec.safeInsets) return spec.safeInsets;
  const s = { top: 60, bottom: 60, left: 50, right: 50 };
  for (const z of spec.safeZones) for (const k of ["top", "bottom", "left", "right"] as const) s[k] = Math.max(s[k], ZONES[z][k]);
  return s;
}

// ---------- Linha do tempo: trechos do original que entram no corte ----------

/** Trecho [a, b) em segundos relativos ao início do corte. */
interface Seg {
  a: number;
  b: number;
}

/** Corta pausas longas entre palavras (silêncio), deixando um respiro curto de cada lado. */
function speechSegments(words: Word[], dur: number): Seg[] {
  const GAP = 0.7;
  const PAD = 0.2;
  const segs: Seg[] = [];
  let a = 0;
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1].s - words[i].e > GAP) {
      segs.push({ a, b: words[i].e + PAD });
      a = words[i + 1].s - PAD;
    }
  }
  segs.push({ a, b: dur });
  return segs.filter((s) => s.b - s.a > 0.25);
}

function buildTimeline(clip: Clip, spec: RenderSpec, words: Word[]): Seg[] {
  const dur = clip.end_s - clip.start_s;
  const body = spec.removeSilence && words.length > 1 ? speechSegments(words, dur) : [{ a: 0, b: dur }];
  return spec.teaser ? [{ a: spec.teaser.start - clip.start_s, b: spec.teaser.end - clip.start_s }, ...body] : body;
}

/** Converte tempos do corte original para a linha do tempo montada (um instante pode aparecer duas vezes: teaser). */
function remap<T extends { t?: number; s?: number; e?: number }>(segs: Seg[], items: T[], key: "t" | "word"): T[] {
  const out: T[] = [];
  let off = 0;
  for (const { a, b } of segs) {
    for (const it of items) {
      if (key === "t") {
        const t = it.t!;
        if (t >= a && t < b) out.push({ ...it, t: off + t - a });
      } else if (it.e! > a && it.s! < b) {
        out.push({ ...it, s: off + Math.max(it.s!, a) - a, e: off + Math.min(it.e!, b) - a });
      }
    }
    off += b - a;
  }
  return out;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const f3 = (n: number) => n.toFixed(3);

interface MediaInfo {
  duration: number;
  hasAudio: boolean;
  vcodec: string;
  width: number;
  height: number;
}
async function probe(path: string): Promise<MediaInfo> {
  const { stdout } = await exec(config.bin.ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", path]);
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  return {
    duration: Number(j.format?.duration) || 0,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    vcodec: v?.codec_name ?? "",
    width: v?.width ?? 0,
    height: v?.height ?? 0,
  };
}

/**
 * Monta o corte numa única passada de ffmpeg:
 * trechos (silêncios/teaser) → reframe → nitidez/zoom → logo → legendas/faixa/lower third/crédito → CTA
 * → trilha e áudio do CTA → vinhetas de abertura/encerramento (concat) → loudnorm.
 */
export async function renderClip(
  clip: Clip, ch: Channel, spec: RenderSpec, assets: Map<number, string>, dir: string, sourcePath: string, transcript: Transcript,
  onProgress: (msg: string) => void,
): Promise<LayoutUsed> {
  const duration = clip.end_s - clip.start_s;
  const OUT = OUTS[spec.aspect];
  const vertical = spec.aspect === "9:16";
  const fps = config.render.fps;
  const [{ width, height }, src] = await Promise.all([probeVideo(sourcePath), probe(sourcePath)]);

  const rawWords = clipWords(transcript.words, clip.start_s, clip.end_s);
  const segs = buildTimeline(clip, spec, rawWords);
  const main = segs.reduce((s, g) => s + g.b - g.a, 0);
  const words = remap(segs, rawWords, "word");

  let plan;
  if (vertical) {
    onProgress("detectando rostos");
    const samples = await detectFaces(sourcePath, clip.start_s, duration, width, height, 3);
    plan = planReframe(clip.layout, remap<FaceSample>(segs, samples, "t"), width, height, OUT);
  } else plan = landscapePlan(width, height, OUT);

  // Posições respeitando as zonas seguras das plataformas.
  const safe = safeInsets(spec);
  const split = plan.layout === "split_screen";
  let subAlign = plan.subAlign;
  let subMarginV = vertical ? Math.max(plan.subMarginV, safe.bottom + 40) : plan.subMarginV;
  let bannerAvoid: { align: number; marginV: number } | undefined;
  if (split) {
    // Dividido: legenda na emenda entre os dois rostos; durante a faixa de título, logo abaixo dela.
    subAlign = 5;
    subMarginV = 0;
    if (!spec.banner?.top) bannerAvoid = { align: 8, marginV: OUT.h / 2 + 190 }; // faixa no topo não disputa a emenda
  }
  const bannerY = vertical ? Math.max(plan.bannerY, safe.top + 170) : plan.bannerY;
  const k = vertical ? 1 : 0.75;

  const keywords = JSON.parse(clip.keywords) as string[];
  // Crédito logo abaixo do logo/selo quando ele fica no canto superior esquerdo (alinhados).
  // Logo embaixo: crédito logo acima dele e a legenda sobe para não encostar nos dois.
  let creditY = safe.top + 20;
  let creditAnchor: "top" | "bottom" = "top";
  let logoInfo: MediaInfo | null = null;
  if (spec.logo) {
    logoInfo = await probe(assets.get(spec.logo.asset.id)!);
    const logoH = logoInfo.width ? Math.round((OUT.w * spec.logo.scale * logoInfo.height) / logoInfo.width) : 0;
    if (spec.logo.position === "top-left" && logoH) creditY = safe.top + 24 + logoH + 14;
    if (spec.logo.position.startsWith("bottom") && logoH) {
      if (spec.logo.position === "bottom-left") {
        creditY = OUT.h - safe.bottom - 24 - logoH - 12;
        creditAnchor = "bottom";
      }
      if (vertical && !split) subMarginV = Math.max(subMarginV, safe.bottom + 24 + logoH + (spec.credit ? 12 + 44 : 0) + 30);
    }
  }
  const assName = `clip-${clip.id}.ass`;
  writeFileSync(
    join(dir, assName),
    buildAss(words, keywords, {
      font: spec.subtitle.font || config.render.font,
      size: spec.subtitle.size,
      color: spec.subtitle.color,
      highlightColor: spec.subtitle.highlight,
      maxWords: spec.subtitle.maxWords,
      outline: spec.subtitle.outline,
      shadow: spec.subtitle.shadow,
      outlineColor: spec.subtitle.outlineColor,
      active: spec.subtitle.active,
      align: subAlign,
      marginV: subMarginV,
      res: { ...OUT, k },
      bannerAvoid,
      banner: spec.banner
        ? {
            title: clip.title, font: spec.banner.font || config.render.titleFont, color: spec.banner.color, textColor: spec.banner.text,
            persist: spec.banner.persist, fullWidth: spec.banner.fullWidth, tilt: spec.banner.tilt, shadowColor: spec.banner.shadowColor,
            shadowOffset: spec.banner.shadowOffset, wrap: spec.banner.wrap,
            topY: spec.banner.top && spec.banner.style === "brush" ? safe.top : null,
            centerY: spec.banner.style === "bar" && vertical && !split ? Math.max(bannerY, safe.top + 330) : bannerY,
            centerX: spec.banner.fullWidth ? (safe.left + OUT.w - safe.right) / 2 : OUT.w / 2,
            maxWidth: spec.banner.fullWidth ? OUT.w - safe.left - safe.right : Math.min(OUT.w - safe.left - safe.right, OUT.w * 0.89), k, duration: main, seed: clip.id,
            style: spec.banner.style, size: spec.banner.size, minTop: vertical ? safe.top + 250 : safe.top + 40, accent: spec.banner.accent, keywords, tag: spec.banner.tag,
            tagFont: spec.credit?.font || spec.subtitle.font || config.render.font, dim: spec.banner.style === "bar", width: OUT.w, height: OUT.h,
          }
        : undefined,
      lowerThird: spec.lowerThird
        ? {
            ...spec.lowerThird,
            at: spec.banner ? 2.6 : 0.5,
            duration: Math.min(spec.lowerThird.duration, Math.max(1, main - 3)),
            x: safe.left + 30,
            y: split || !vertical ? OUT.h - safe.bottom - 40 : OUT.h - subMarginV - 240,
          }
        : undefined,
      credit: spec.credit
        ? { ...spec.credit, x: safe.left + (spec.logo?.position.endsWith("left") ? 24 : 20), y: creditY, anchor: creditAnchor }
        : undefined,
    }),
  );

  // ----- Entradas -----
  const inputs: string[][] = [["-ss", f3(clip.start_s), "-t", f3(duration), "-i", sourcePath]];
  const addInput = (args: string[]) => inputs.push(args) - 1;
  const g: string[] = [];

  // Trechos → [src][sa]
  const n = segs.length;
  const trimV = (i: number, s: Seg) => `trim=start=${f3(s.a)}:end=${f3(s.b)},setpts=PTS-STARTPTS`;
  const trimA = (s: Seg) => `atrim=start=${f3(s.a)}:end=${f3(s.b)},asetpts=PTS-STARTPTS`;
  if (n === 1) {
    g.push(`[0:v]fps=${fps},${trimV(0, segs[0])}[src]`);
    g.push(src.hasAudio ? `[0:a]${trimA(segs[0])}[sa]` : `anullsrc=r=48000:cl=stereo,atrim=end=${f3(main)}[sa]`);
  } else {
    g.push(`[0:v]fps=${fps},split=${n}${segs.map((_, i) => `[sv${i}]`).join("")}`);
    segs.forEach((s, i) => g.push(`[sv${i}]${trimV(i, s)}[tv${i}]`));
    if (src.hasAudio) {
      g.push(`[0:a]asplit=${n}${segs.map((_, i) => `[sx${i}]`).join("")}`);
      segs.forEach((s, i) => g.push(`[sx${i}]${trimA(s)}[ta${i}]`));
      g.push(`${segs.map((_, i) => `[tv${i}][ta${i}]`).join("")}concat=n=${n}:v=1:a=1[src][sa]`);
    } else {
      g.push(`${segs.map((_, i) => `[tv${i}]`).join("")}concat=n=${n}:v=1:a=0[src]`);
      g.push(`anullsrc=r=48000:cl=stereo,atrim=end=${f3(main)}[sa]`);
    }
  }

  // Reframe → [base]
  g.push(plan.graph.replaceAll("[0:v]", "[src]"));
  let last = "base";
  const step = (filter: string, label: string) => {
    g.push(`[${last}]${filter}[${label}]`);
    last = label;
  };
  // Recorte ampliado (ex.: 608x1080 → 1080x1920) perde nitidez; um unsharp leve recupera bordas.
  if (plan.upscale > 1.15) step("unsharp=5:5:0.7:5:5:0", "sharp");
  const zooms = clip.zoom && plan.canZoom ? emphasisTimes(words, keywords) : [];
  // Zoom de ritmo (modelo): leve, a cada N segundos, fora das janelas de ênfase.
  const beats: number[] = [];
  if (spec.zoomEvery > 0 && plan.canZoom) {
    for (let t = spec.zoomEvery; t < main - 1; t += spec.zoomEvery) if (!zooms.some((z) => Math.abs(z - t) < 1.5)) beats.push(t);
  }
  if (zooms.length || beats.length) {
    const win = (ts: number[], len: number) => ts.map((t) => `between(in_time,${t.toFixed(2)},${(t + len).toFixed(2)})`).join("+") || "0";
    step(`zoompan=z='if(${win(zooms, 0.9)},1.12,if(${win(beats, 1.6)},1.06,1))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OUT.w}x${OUT.h}:fps=${fps}`, "zoomed");
  }

  // Logo / marca d'água (abaixo das legendas)
  if (spec.logo && logoInfo) {
    const li = addInput(["-i", assets.get(spec.logo.asset.id)!]);
    const m = 24;
    const [vy, hx] = spec.logo.position.split("-");
    const x = hx === "left" ? `${safe.left + m}` : `W-w-${safe.right + m}`;
    const y = vy === "top" ? `${safe.top + m}` : `H-h-${safe.bottom + m}`;
    g.push(`[${li}:v]scale=${even(OUT.w * spec.logo.scale)}:-2,format=rgba,colorchannelmixer=aa=${spec.logo.opacity.toFixed(2)}[logo]`);
    g.push(`[${last}][logo]overlay=x=${x}:y=${y}:format=auto[lg]`);
    last = "lg";
  }

  const fontsDir = config.render.fontsDir ? `:fontsdir='${config.render.fontsDir.replaceAll("\\", "/").replaceAll(":", "\\:")}'` : "";
  step(`ass=${assName}${fontsDir}`, "subbed");

  // Pedido de inscrição (animação sobreposta no momento configurado)
  const audioMix = ["sa"];
  if (spec.cta) {
    const file = assets.get(spec.cta.asset.id)!;
    const ext = spec.cta.asset.ext;
    const isImage = ext === "png" || ext === "gif";
    const info = isImage ? { duration: 4, hasAudio: false, vcodec: "" } : await probe(file);
    const decoder = info.vcodec === "vp9" ? ["-c:v", "libvpx-vp9"] : info.vcodec === "vp8" ? ["-c:v", "libvpx"] : []; // mantém o alfa do .webm
    const ci = addInput(ext === "png" ? ["-loop", "1", "-t", "4", "-i", file] : ext === "gif" ? ["-ignore_loop", "0", "-t", "4", "-i", file] : [...decoder, "-i", file]);
    const ctaDur = Math.min(info.duration || 4, main);
    const at = ctaStart(spec.cta.at, main, ctaDur);
    const key = spec.cta.key === "green" ? ",colorkey=0x00FF00:0.30:0.12" : "";
    const y = spec.cta.position === "top" ? `${safe.top + 220}` : spec.cta.position === "center" ? "(H-h)/2"
      : split || !vertical ? `H-h-${safe.bottom + 20}` : `H-h-${subMarginV + 260}`;
    g.push(`[${ci}:v]scale=${even(OUT.w * spec.cta.scale)}:-2,format=rgba${key},trim=duration=${f3(ctaDur)},setpts=PTS-STARTPTS+${f3(at)}/TB[cta]`);
    g.push(`[${last}][cta]overlay=x=(W-w)/2:y=${y}:eof_action=pass:format=auto[ctad]`);
    last = "ctad";
    if (info.hasAudio) {
      const ms = Math.round(at * 1000);
      g.push(`[${ci}:a]aresample=48000,atrim=end=${f3(ctaDur)},adelay=${ms}:all=1[ctaa]`);
      audioMix.push("ctaa");
    }
  }
  g.push(`[${last}]format=yuv420p[mv]`);

  // Trilha de fundo
  if (spec.music) {
    const mi = addInput(["-stream_loop", "-1", "-i", assets.get(spec.music.asset.id)!]);
    g.push(`[${mi}:a]aresample=48000,volume=${spec.music.volume.toFixed(3)},atrim=end=${f3(main)}[mus]`);
    audioMix.push("mus");
  }
  const af = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  g.push(
    audioMix.length > 1
      ? `${audioMix.map((l) => `[${l}]`).join("")}amix=inputs=${audioMix.length}:duration=first:normalize=0,${af}[ma]`
      : `[sa]${af}[ma]`,
  );

  // Vinhetas de abertura e encerramento
  const parts: { v: string; a: string }[] = [];
  let introDur = 0;
  let outroDur = 0;
  for (const which of ["intro", "outro"] as const) {
    const ref = spec[which];
    if (!ref) continue;
    const file = assets.get(ref.id)!;
    const info = await probe(file);
    const vi = addInput(["-i", file]);
    g.push(`[${vi}:v]scale=${OUT.w}:${OUT.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${OUT.w}:${OUT.h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},setsar=1,format=yuv420p[${which}v]`);
    g.push(info.hasAudio ? `[${vi}:a]${af}[${which}a]` : `anullsrc=r=48000:cl=stereo,atrim=end=${f3(info.duration)},${af}[${which}a]`);
    if (which === "intro") introDur = info.duration;
    else outroDur = info.duration;
  }
  if (spec.intro) parts.push({ v: "introv", a: "introa" });
  parts.push({ v: "mv", a: "ma" });
  if (spec.outro) parts.push({ v: "outrov", a: "outroa" });
  let vOut = "mv";
  let aIn = "ma";
  if (parts.length > 1) {
    g.push(`${parts.map((p) => `[${p.v}][${p.a}]`).join("")}concat=n=${parts.length}:v=1:a=1[cv][ca]`);
    vOut = "cv";
    aIn = "ca";
  }
  g.push(`[${aIn}]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);

  onProgress("renderizando");
  const total = introDur + main + outroDur;
  const out = `clip-${clip.id}.mp4`;
  await exec(
    config.bin.ffmpeg,
    [
      "-y", "-v", "error", "-stats",
      ...inputs.flat(),
      "-filter_complex", g.join(";"),
      "-map", `[${vOut}]`, "-map", "[aout]",
      ...videoCodecArgs(),
      "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", f3(total + 0.05), // a trilha em loop nunca acaba sozinha
      "-movflags", "+faststart",
      out,
    ],
    {
      cwd: dir, // caminho relativo do .ass evita o inferno de escape do filtro no Windows
      onStderr: (line) => {
        const m = line.match(/time=(\d+):(\d+):(\d+)/);
        if (m) onProgress(`renderizando ${Math.min(100, Math.round(((+m[1] * 3600 + +m[2] * 60 + +m[3]) / total) * 100))}%`);
      },
    },
  );
  // Miniatura no meio da faixa de título (depois da vinheta de abertura).
  const thumbAt = introDur + Math.min(1.5, main / 2);
  await exec(config.bin.ffmpeg, ["-y", "-v", "error", "-ss", f3(thumbAt), "-i", out, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", `clip-${clip.id}.jpg`], { cwd: dir });
  // Prévia 720p para o Telegram (o bot só aceita vídeos até 50 MB; o arquivo final passa disso).
  await exec(config.bin.ffmpeg, [
    "-y", "-v", "error", "-i", out, "-vf", `scale=${vertical ? "720:-2" : "-2:720"}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
    "-maxrate", "2500k", "-bufsize", "5000k", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", `clip-${clip.id}.preview.mp4`,
  ], { cwd: dir });
  return plan.layout;
}

/**
 * Proxy leve (360p) do trecho original com 60 s de folga de cada lado: é o que o Estúdio usa para o
 * ajuste fino de início/fim, já que o hub não guarda o vídeo-fonte.
 */
export async function makeProxy(clip: Clip, dir: string, sourcePath: string, sourceDuration: number) {
  const proxy_start = Math.max(0, Math.floor(clip.start_s - 60));
  const proxy_end = Math.min(sourceDuration || clip.end_s + 60, Math.ceil(clip.end_s + 60));
  await exec(config.bin.ffmpeg, [
    "-y", "-v", "error",
    "-ss", String(proxy_start), "-t", String(proxy_end - proxy_start), "-i", sourcePath,
    "-vf", "scale=-2:360", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32",
    "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-movflags", "+faststart",
    clipFile(dir, clip.id, "proxy"),
  ]);
  return { proxy_start, proxy_end };
}
