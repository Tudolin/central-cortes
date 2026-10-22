import { spawn } from "node:child_process";
import * as ort from "onnxruntime-node";
import { config } from "../config.ts";

export interface Face {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
}

export interface FaceSample {
  t: number; // segundos relativos ao início do corte
  faces: Face[];
}

const SIZE = 640; // YuNet 2023mar tem entrada fixa 1x3x640x640
let session: Promise<ort.InferenceSession> | null = null;
const getSession = () => (session ??= ort.InferenceSession.create(config.faceModel, { intraOpNumThreads: 4 }));

/**
 * Amostra o trecho a `fps` quadros/s via ffmpeg (rawvideo BGR) e roda YuNet em cada quadro.
 * Coordenadas retornadas no espaço de pixels do vídeo original.
 */
export async function detectFaces(path: string, start: number, duration: number, width: number, height: number, fps = 2): Promise<FaceSample[]> {
  const sess = await getSession();
  const scale = SIZE / Math.max(width, height);
  const sw = Math.floor((width * scale) / 2) * 2;
  const sh = Math.floor((height * scale) / 2) * 2;
  const frameBytes = SIZE * SIZE * 3;

  const ff = spawn(
    config.bin.ffmpeg,
    [
      "-v", "error", "-ss", String(start), "-t", String(duration), "-i", path,
      "-vf", `fps=${fps},scale=${sw}:${sh},pad=${SIZE}:${SIZE}:0:0`,
      "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );

  const samples: FaceSample[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let frame = 0;
  // for-await aplica backpressure: o ffmpeg espera enquanto a inferência roda.
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const faces = await inferFrame(sess, pending.subarray(0, frameBytes));
      samples.push({ t: frame / fps, faces: faces.map((f) => ({ cx: f.cx / scale, cy: f.cy / scale, w: f.w / scale, h: f.h / scale, score: f.score })) });
      pending = pending.subarray(frameBytes);
      frame++;
    }
  }
  return samples;
}

async function inferFrame(sess: ort.InferenceSession, bgr: Buffer): Promise<Face[]> {
  const n = SIZE * SIZE;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = bgr[i * 3];
    data[n + i] = bgr[i * 3 + 1];
    data[2 * n + i] = bgr[i * 3 + 2];
  }
  const out = await sess.run({ input: new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]) });

  const faces: Face[] = [];
  for (const stride of [8, 16, 32]) {
    const cls = out[`cls_${stride}`].data as Float32Array;
    const obj = out[`obj_${stride}`].data as Float32Array;
    const box = out[`bbox_${stride}`].data as Float32Array;
    const cols = SIZE / stride;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < 0.6) continue;
      const r = Math.floor(i / cols);
      const c = i % cols;
      faces.push({
        cx: (c + box[i * 4]) * stride,
        cy: (r + box[i * 4 + 1]) * stride,
        w: Math.exp(box[i * 4 + 2]) * stride,
        h: Math.exp(box[i * 4 + 3]) * stride,
        score,
      });
    }
  }
  return nms(faces, 0.3);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function nms(faces: Face[], iouThreshold: number): Face[] {
  faces.sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const f of faces) if (kept.every((k) => iou(k, f) < iouThreshold)) kept.push(f);
  return kept;
}

function iou(a: Face, b: Face): number {
  const x1 = Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
  const y1 = Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
  const x2 = Math.min(a.cx + a.w / 2, b.cx + b.w / 2);
  const y2 = Math.min(a.cy + a.h / 2, b.cy + b.h / 2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}
