import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { Channel, Clip } from "../db.ts";
import { exec } from "../proc.ts";
import { detectFaces } from "./faces.ts";
import { planReframe, type LayoutUsed, type Out } from "./reframe.ts";
import { probeVideo } from "./source.ts";
import { buildAss, clipWords, emphasisTimes } from "./subtitles.ts";
import type { Transcript } from "./transcribe.ts";

export type ClipArtifact = "mp4" | "jpg" | "ass" | "proxy" | "preview";
export const clipFile = (dir: string, clipId: number, ext: ClipArtifact) =>
  join(dir, ext === "proxy" || ext === "preview" ? `clip-${clipId}.${ext}.mp4` : `clip-${clipId}.${ext}`);

const OUT: Out = { w: 1080, h: 1920 };

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

/** Reframe + faixa de título + legendas + zoom + loudnorm em uma única passada de ffmpeg. */
export async function renderClip(clip: Clip, ch: Channel, dir: string, sourcePath: string, transcript: Transcript, onProgress: (msg: string) => void): Promise<LayoutUsed> {
  const duration = clip.end_s - clip.start_s;
  const { width, height } = await probeVideo(sourcePath);

  onProgress("detectando rostos");
  const samples = await detectFaces(sourcePath, clip.start_s, duration, width, height, 3);
  const plan = planReframe(clip.layout, samples, width, height, OUT);

  const words = clipWords(transcript.words, clip.start_s, clip.end_s);
  const keywords = JSON.parse(clip.keywords) as string[];
  const assName = `clip-${clip.id}.ass`;
  writeFileSync(
    join(dir, assName),
    buildAss(words, keywords, {
      font: config.render.font,
      highlightColor: ch.highlight_color,
      maxWords: ch.max_words_per_frame,
      align: plan.subAlign,
      marginV: plan.subMarginV,
      banner: ch.title_banner
        ? {
            title: clip.title,
            font: config.render.titleFont,
            color: ch.banner_color,
            textColor: ch.banner_text_color,
            centerY: plan.bannerY,
            duration,
            seed: clip.id,
          }
        : undefined,
    }),
  );

  const fps = config.render.fps;
  let graph = `[0:v]fps=${fps}[src];` + plan.graph.replaceAll("[0:v]", "[src]");
  let last = "base";
  // Recorte ampliado (ex.: 608x1080 → 1080x1920) perde nitidez; um unsharp leve recupera bordas.
  if (plan.upscale > 1.15) {
    graph += `;[${last}]unsharp=5:5:0.7:5:5:0[sharp]`;
    last = "sharp";
  }
  const zooms = clip.zoom && plan.canZoom ? emphasisTimes(words, keywords) : [];
  if (zooms.length) {
    const z = zooms.map((t) => `between(in_time,${t.toFixed(2)},${(t + 0.9).toFixed(2)})`).join("+");
    graph += `;[${last}]zoompan=z='if(${z},1.12,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OUT.w}x${OUT.h}:fps=${fps}[zoomed]`;
    last = "zoomed";
  }
  const fontsDir = config.render.fontsDir ? `:fontsdir='${config.render.fontsDir.replaceAll("\\", "/").replaceAll(":", "\\:")}'` : "";
  graph += `;[${last}]ass=${assName}${fontsDir}[v]`;

  onProgress("renderizando");
  const out = `clip-${clip.id}.mp4`;
  await exec(
    config.bin.ffmpeg,
    [
      "-y", "-v", "error", "-stats",
      "-ss", clip.start_s.toFixed(3), "-t", duration.toFixed(3), "-i", sourcePath,
      "-filter_complex", graph,
      "-map", "[v]", "-map", "0:a:0?",
      ...videoCodecArgs(),
      "-pix_fmt", "yuv420p", "-r", String(fps),
      "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart",
      out,
    ],
    {
      cwd: dir, // caminho relativo do .ass evita o inferno de escape do filtro no Windows
      onStderr: (line) => {
        const m = line.match(/time=(\d+):(\d+):(\d+)/);
        if (m) onProgress(`renderizando ${Math.min(100, Math.round(((+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration) * 100))}%`);
      },
    },
  );
  await exec(config.bin.ffmpeg, ["-y", "-v", "error", "-ss", "1.5", "-i", out, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", `clip-${clip.id}.jpg`], { cwd: dir });
  // Prévia 720p para o Telegram (o bot só aceita vídeos até 50 MB; o arquivo final passa disso).
  await exec(config.bin.ffmpeg, [
    "-y", "-v", "error", "-i", out, "-vf", "scale=720:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
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
