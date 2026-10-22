import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config.ts";
import { exec } from "../proc.ts";

export const jobDir = (jobId: number) => {
  const dir = join(config.workDir, `job-${jobId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

export interface SourceInfo {
  path: string;
  videoId: string;
  videoUrl: string;
  title: string;
  duration: number;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** Baixa (yt-dlp) ou referencia um arquivo local. Idempotente: reaproveita source.json se existir. */
export async function fetchSource(jobId: number, source: string, onProgress: (msg: string) => void): Promise<SourceInfo> {
  const dir = jobDir(jobId);
  const cache = join(dir, "source.json");
  if (existsSync(cache)) {
    const info = JSON.parse(readFileSync(cache, "utf8")) as SourceInfo;
    if (existsSync(info.path)) return info;
  }

  let info: SourceInfo;
  if (isUrl(source)) {
    const out = join(dir, "source.mp4");
    const { stdout } = await exec(
      config.bin.ytdlp,
      [
        "--no-playlist",
        "--no-simulate",
        "--newline",
        "-f", "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format", "mp4",
        "-o", out,
        "--force-overwrites",
        "--print", "before_dl:%(id)s\t%(duration)s\t%(webpage_url)s\t%(title)s",
        source,
      ],
      { onStderr: (line) => line.includes("%") && onProgress(line.trim().slice(0, 120)) },
    );
    const [videoId = "", duration = "0", videoUrl = source, ...title] = stdout.trim().split("\n")[0].split("\t");
    info = { path: out, videoId, videoUrl, title: title.join("\t"), duration: Number(duration) || (await probeDuration(out)) };
  } else {
    if (!existsSync(source)) throw new Error(`Arquivo não encontrado: ${source}`);
    info = { path: source, videoId: "", videoUrl: "", title: basename(source).replace(/\.[^.]+$/, ""), duration: await probeDuration(source) };
  }
  writeFileSync(cache, JSON.stringify(info, null, 2));
  return info;
}

export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await exec(config.bin.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(stdout.trim()) || 0;
}

export async function probeVideo(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await exec(config.bin.ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
  ]);
  const [width, height] = stdout.trim().split("x").map(Number);
  return { width, height };
}
