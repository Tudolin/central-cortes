import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { config } from "./config.ts";
import { exec } from "./proc.ts";

/**
 * Diagnóstico da instalação: `npm run doctor`.
 * Confere só o que o papel desta máquina (ROLE) usa e diz o que fazer em cada falha. Não altera nada.
 */

let failed = 0;
const ok = (what: string, detail = "") => console.log(`  ok    ${what}${detail ? ` — ${detail}` : ""}`);
const warn = (what: string, fix: string) => console.log(`  aviso ${what}\n        ${fix}`);
const fail = (what: string, fix: string) => {
  failed++;
  console.log(`  FALHA ${what}\n        ${fix}`);
};

const isHub = config.role === "hub" || config.role === "all";
const isWorker = config.role === "worker" || config.role === "all";

async function binary(name: string, bin: string, args: string[], envKey: string) {
  try {
    const { stdout, stderr } = await exec(bin, args);
    ok(name, (stdout || stderr).split(/\r?\n/)[0].trim().slice(0, 70));
    return true;
  } catch {
    fail(name, `"${bin}" não foi encontrado. Instale e deixe no PATH, ou aponte o caminho em ${envKey} no .env.`);
    return false;
  }
}

console.log(`Central de Cortes — diagnóstico (ROLE=${config.role})\n`);

const major = Number(process.versions.node.split(".")[0]);
if (major >= 24) ok("Node.js", process.versions.node);
else fail("Node.js", `Versão ${process.versions.node}; é preciso a 24 ou mais nova.`);

if (!["hub", "worker", "all"].includes(config.role)) fail("ROLE", `Valor "${config.role}" inválido no .env: use all, hub ou worker.`);

if (isHub) {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.W_OK);
    ok("Pasta de dados", config.dataDir);
  } catch {
    fail("Pasta de dados", `Sem permissão de escrita em ${config.dataDir}.`);
  }
  const local = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  if (config.dashboardPassword || local) ok("Painel", `http://${local ? "localhost" : config.host}:${config.port}${local ? " (só nesta máquina)" : ""}`);
  else warn("Painel sem senha", "Qualquer aparelho da rede abre o painel. Defina DASHBOARD_PASSWORD no .env, ou HOST=127.0.0.1 para atender só esta máquina.");
}

if (isWorker) {
  const ffmpeg = await binary("ffmpeg", config.bin.ffmpeg, ["-version"], "FFMPEG_BIN");
  await binary("ffprobe", config.bin.ffprobe, ["-version"], "FFPROBE_BIN");
  await binary("yt-dlp", config.bin.ytdlp, ["--version"], "YTDLP_BIN");
  await binary("whisper.cpp", config.bin.whisper, ["-h"], "WHISPER_BIN");

  if (existsSync(config.whisperModel)) ok("Modelo do whisper", config.whisperModel);
  else fail("Modelo do whisper", `Arquivo ${config.whisperModel} não existe. Baixe o modelo ou ajuste WHISPER_MODEL no .env.`);

  if (!existsSync(config.faceModel)) fail("Modelo de rostos", `Arquivo ${config.faceModel} não existe (vem junto com o repositório).`);
  else {
    try {
      await import("onnxruntime-node");
      ok("Detecção de rostos");
    } catch {
      fail("Detecção de rostos", "Pacote onnxruntime-node ausente. Rode: npm install");
    }
  }

  const { vcodec } = config.render;
  if (ffmpeg && vcodec !== "libx264") {
    const { stdout } = await exec(config.bin.ffmpeg, ["-hide_banner", "-encoders"]).catch(() => ({ stdout: "" }));
    if (stdout.includes(` ${vcodec} `)) ok("Encoder de vídeo", vcodec);
    else fail("Encoder de vídeo", `Este ffmpeg não tem "${vcodec}". Use FFMPEG_VCODEC=libx264 no .env.`);
  }

  const ollama = await fetch(`${config.ollamaUrl}/api/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  const hasOllama = ollama || existsSync(config.ollamaBin);
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  if (config.localAi === "always") {
    if (hasOllama) ok("IA", `local (Ollama, modelo ${config.localModel})`);
    else fail("IA", "LOCAL_AI=always, mas o Ollama não está instalado. Instale o Ollama ou defina ANTHROPIC_API_KEY e LOCAL_AI=auto.");
  } else if (hasKey) ok("IA", `Claude (${config.defaultModel})${config.localAi === "auto" && hasOllama ? ", com Ollama de reserva" : ""}`);
  else if (config.localAi === "auto" && hasOllama) warn("IA sem chave da Anthropic", "A análise vai cair sempre na IA local (Ollama). Para deixar isso explícito, use LOCAL_AI=always.");
  else fail("IA", "Defina ANTHROPIC_API_KEY no .env, ou instale o Ollama e use LOCAL_AI=always.");
}

if (config.role === "worker") {
  if (!config.workerToken) fail("WORKER_TOKEN", "Vazio no .env: precisa ser igual ao WORKER_TOKEN do hub.");
  else {
    try {
      const r = await fetch(`${config.hubUrl}/api/worker/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.workerToken}`, "x-worker": config.workerName, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) ok("Hub", `${config.hubUrl} respondeu e aceitou o token`);
      else if (r.status === 401) fail("Hub", `${config.hubUrl} recusou o token: o WORKER_TOKEN daqui é diferente do .env do hub.`);
      else fail("Hub", `${config.hubUrl} respondeu HTTP ${r.status}. Confira se HUB_URL aponta para a Central de Cortes.`);
    } catch (e) {
      fail("Hub", `Sem resposta de ${config.hubUrl} (${(e as Error).message}). O hub está no ar? Esta máquina alcança esse endereço (rede/Tailscale)?`);
    }
  }
}

console.log(failed ? `\n${failed} problema(s) para resolver.` : "\nTudo certo.");
process.exit(failed ? 1 : 0);
