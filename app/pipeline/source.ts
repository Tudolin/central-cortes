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
  uploader?: string;
  duration: number;
}

const potUrl = () => {
  if (config.ytdlpPotUrl === "off") return "";
  if (config.ytdlpPotUrl) return config.ytdlpPotUrl;
  try {
    return `http://${new URL(config.hubUrl).hostname}:4416`;
  } catch {
    return "";
  }
};

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
        // O YouTube exige resolver um desafio em JS; sem runtime o download volta 403.
        // Reaproveita o próprio Node que roda o worker (yt-dlp só ativa o deno por padrão).
        "--js-runtimes", `node:${process.execPath}`,
        ...(existsSync(config.ytdlpCookies) ? ["--cookies", config.ytdlpCookies]
          : existsSync(config.ytdlpRobotCookies) ? ["--cookies", config.ytdlpRobotCookies] : []),
        // PO token (bgutil): o yt-dlp pede ao servidor quando o cliente do YouTube exigir; se estiver fora, segue sem.
        ...(potUrl() ? ["--extractor-args", `youtubepot-bgutilhttp:base_url=${potUrl()}`] : []),
        "--encoding", "utf-8", // no Windows o padrão é a code page do console e quebra acentos do título
        "--retries", "10", "--fragment-retries", "10",
        "--progress", // --print implica --quiet; isto mantém o progresso para o dashboard
        "--newline",
        "--progress-template", "download:baixando %(progress._percent_str)s de %(progress._total_bytes_str)s",
        "-f", "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format", "mp4",
        "-o", out,
        "--force-overwrites",
        "--print", "before_dl:%(id)s\t%(duration)s\t%(webpage_url)s\t%(uploader_id,uploader)s\t%(title)s",
        source,
      ],
      {
        onStdout: (line) => line.startsWith("baixando") && onProgress(line.trim().replace(/\s+/g, " ").slice(0, 120)),
        onStderr: (line) => line.startsWith("baixando") && onProgress(line.trim().replace(/\s+/g, " ").slice(0, 120)),
      },
    );
    const infoLine = stdout.split(/\r?\n/).find((l) => l.split("\t").length >= 5) ?? "";
    const [videoId = "", duration = "0", videoUrl = source, uploader = "", ...title] = infoLine.split("\t");
    info = { path: out, videoId, videoUrl, uploader: uploader === "NA" ? "" : uploader, title: title.join("\t"), duration: Number(duration) || (await probeDuration(out)) };
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
