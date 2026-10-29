import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";

export type ClipFile = "mp4" | "jpg" | "proxy" | "preview";

export function jobMediaDir(jobId: number) {
  const dir = join(config.mediaDir, `job-${jobId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const clipPath = (jobId: number, clipId: number, kind: ClipFile) =>
  join(jobMediaDir(jobId), kind === "proxy" || kind === "preview" ? `clip-${clipId}.${kind}.mp4` : `clip-${clipId}.${kind}`);

/** Vídeos finais pedidos pelo botão Baixar (clipId → quando): o PC reenvia e o hub guarda por 1 dia. */
export const finalDownloads = new Map<number, number>();
export const wantsDownload = (clipId: number) => Date.now() - (finalDownloads.get(clipId) ?? 0) < 86400_000;

export const transcriptPath = (jobId: number) => join(jobMediaDir(jobId), "transcript.json");

export function removeClipFiles(jobId: number, clipId: number, kinds: ClipFile[] = ["mp4", "jpg", "proxy", "preview"]) {
  for (const k of kinds) rmSync(clipPath(jobId, clipId, k), { force: true });
}
