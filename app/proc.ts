import { spawn, type SpawnOptions } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Executa um binário sem shell (argumentos nunca são interpolados). Rejeita com o fim do stderr. */
export function exec(cmd: string, args: string[], opts: SpawnOptions & { onStderr?: (line: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d));
    child.stderr!.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-20_000);
      if (opts.onStderr) for (const line of text.split(/[\r\n]+/)) if (line.trim()) opts.onStderr(line);
    });
    child.on("error", (err) => reject(new Error(`${cmd}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} saiu com código ${code}: ${stderr.trim().split("\n").slice(-6).join("\n")}`));
    });
  });
}

export function hms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
