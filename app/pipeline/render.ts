import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { Channel, Clip } from "../db.ts";
import { exec } from "../proc.ts";
import { detectFaces } from "./faces.ts";
import { planReframe, type LayoutUsed } from "./reframe.ts";
import { probeVideo } from "./source.ts";
import { buildAss, clipWords, emphasisTimes } from "./subtitles.ts";
import type { Transcript } from "./transcribe.ts";

export const clipFile = (dir: string, clipId: number, ext: "mp4" | "jpg" | "ass") => join(dir, `clip-${clipId}.${ext}`);

/** Reframe + legendas + zoom + loudnorm em uma única passada de ffmpeg. */
export async function renderClip(clip: Clip, ch: Channel, dir: string, sourcePath: string, transcript: Transcript, onProgress: (msg: string) => void): Promise<LayoutUsed> {
  const duration = clip.end_s - clip.start_s;
  const { width, height } = await probeVideo(sourcePath);

  onProgress("detectando rostos");
  const samples = await detectFaces(sourcePath, clip.start_s, duration, width, height, 3);
  const plan = planReframe(clip.layout, samples, width, height);

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
    }),
  );

  const fps = config.render.fps;
  let graph = `[0:v]fps=${fps}[src];` + plan.graph.replaceAll("[0:v]", "[src]");
  let last = "base";
  const zooms = clip.zoom && plan.canZoom ? emphasisTimes(words, keywords) : [];
  if (zooms.length) {
    const z = zooms.map((t) => `between(in_time,${t.toFixed(2)},${(t + 0.9).toFixed(2)})`).join("+");
    graph += `;[base]zoompan=z='if(${z},1.12,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=${fps}[zoomed]`;
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
      "-c:v", config.render.vcodec, "-preset", config.render.preset, "-crf", config.render.crf,
      "-pix_fmt", "yuv420p", "-r", String(fps),
      "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
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
  return plan.layout;
}
