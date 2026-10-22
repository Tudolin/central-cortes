import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { exec } from "../proc.ts";

export interface Word {
  w: string;
  s: number;
  e: number;
}

/** Frase: intervalo [i0, i1] de palavras, usado para "snap" de cortes e para o prompt compacto. */
export interface Sentence {
  s: number;
  e: number;
  i0: number;
  i1: number;
  text: string;
}

export interface Transcript {
  words: Word[];
  sentences: Sentence[];
}

export function loadTranscript(dir: string): Transcript {
  return JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as Transcript;
}

/** ffmpeg → WAV 16 kHz mono → whisper.cpp com timestamps por palavra. Cacheado em transcript.json. */
export async function transcribe(dir: string, sourcePath: string, onProgress: (msg: string) => void): Promise<Transcript> {
  const out = join(dir, "transcript.json");
  if (existsSync(out)) return loadTranscript(dir);

  const wav = join(dir, "audio.wav");
  onProgress("extraindo áudio");
  await exec(config.bin.ffmpeg, ["-y", "-v", "error", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);

  onProgress("whisper 0%");
  const base = join(dir, "whisper");
  await exec(
    config.bin.whisper,
    [
      "-m", config.whisperModel,
      "-f", wav,
      "-l", config.whisperLanguage,
      "-t", String(config.whisperThreads),
      "-ml", "1", "-sow", // um segmento por palavra
      "-oj", "-of", base,
      "-pp",
    ],
    {
      onStderr: (line) => {
        const m = line.match(/progress\s*=\s*(\d+)%/);
        if (m) onProgress(`whisper ${m[1]}%`);
      },
    },
  );

  const raw = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    transcription: { offsets: { from: number; to: number }; text: string }[];
  };
  const words: Word[] = [];
  for (const seg of raw.transcription) {
    const w = seg.text.trim();
    if (!w || /^\[_.*_\]$/.test(w)) continue;
    // Pontuação isolada gruda na palavra anterior.
    if (/^[.,!?;:…]+$/.test(w) && words.length) {
      words[words.length - 1].w += w;
      words[words.length - 1].e = seg.offsets.to / 1000;
      continue;
    }
    words.push({ w, s: seg.offsets.from / 1000, e: seg.offsets.to / 1000 });
  }

  const transcript = { words, sentences: buildSentences(words) };
  writeFileSync(out, JSON.stringify(transcript));
  rmSync(wav, { force: true });
  return transcript;
}

/** Quebra em frases por pontuação final, pausa > 0.8 s ou 30 palavras. */
export function buildSentences(words: Word[]): Sentence[] {
  const sentences: Sentence[] = [];
  let i0 = 0;
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    const end =
      !next || /[.!?…]["”']?$/.test(words[i].w) || next.s - words[i].e > 0.8 || i - i0 >= 29;
    if (end) {
      sentences.push({
        s: words[i0].s,
        e: words[i].e,
        i0,
        i1: i,
        text: words.slice(i0, i + 1).map((x) => x.w).join(" "),
      });
      i0 = i + 1;
    }
  }
  return sentences;
}

/** Texto compacto para o LLM: uma linha a cada ~12 s, prefixada pelo segundo inicial. */
export function compactTranscript(t: Transcript): string {
  const lines: string[] = [];
  let buf: Sentence[] = [];
  const flush = () => {
    if (!buf.length) return;
    lines.push(`${Math.floor(buf[0].s)}|${buf.map((x) => x.text).join(" ")}`);
    buf = [];
  };
  for (const s of t.sentences) {
    buf.push(s);
    if (s.e - buf[0].s >= 12) flush();
  }
  flush();
  return lines.join("\n");
}
