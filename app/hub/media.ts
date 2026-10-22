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

export const transcriptPath = (jobId: number) => join(jobMediaDir(jobId), "transcript.json");

export function removeClipFiles(jobId: number, clipId: number, kinds: ClipFile[] = ["mp4", "jpg", "proxy", "preview"]) {
  for (const k of kinds) rmSync(clipPath(jobId, clipId, k), { force: true });
}
