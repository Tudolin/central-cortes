import { statfsSync } from "node:fs";
import { config } from "../config.ts";
import { all, type Clip } from "../db.ts";
import { bus } from "../events.ts";
import { removeClipFiles } from "./media.ts";
import { tg } from "./telegram.ts";
import { FINAL_WINDOW_H } from "./workerApi.ts";

/**
 * Proteção de disco do hub (o notebook tem pouco espaço e o SQLite derruba o hub quando o disco enche).
 * - Limpeza contínua do que é temporário (proxy do Estúdio fora da revisão, prévia do Telegram já enviada,
 *   arquivos de publicados após RETENTION_DAYS, rejeitados após 2 dias).
 * - Abaixo de LOW_GB: apaga também os vídeos de publicados na hora.
 * - Abaixo de CRITICAL_GB: o worker para de receber tarefas novas (claim devolve "idle") e o Telegram avisa.
 */
const LOW_GB = 4;
const CRITICAL_GB = 2;

export const freeGb = () => {
  const s = statfsSync(config.dataDir);
  return (s.bavail * s.bsize) / 1e9;
};

export const diskState = () => {
  const free = freeGb();
  return { freeGb: Math.round(free * 10) / 10, low: free < LOW_GB, critical: free < CRITICAL_GB };
};

function prune() {
  const low = freeGb() < LOW_GB;
  const retention = new Date(Date.now() - (low ? 0 : config.retentionDays) * 86400_000).toISOString();
  for (const c of all<Clip>("SELECT * FROM clips")) {
    if (c.status === "REJECTED" && Date.parse(c.updated_at + "Z") < Date.now() - 2 * 86400_000) {
      removeClipFiles(c.job_id, c.id);
      continue;
    }
    if (c.status === "PUBLISHED" && (c.published_at ?? "") < retention) {
      removeClipFiles(c.job_id, c.id, ["mp4", "proxy", "preview"]);
      continue;
    }
    // Proxy só serve para o ajuste fino durante a revisão.
    if (!["PENDING_REVIEW", "RENDER_QUEUED", "RENDERING"].includes(c.status)) removeClipFiles(c.job_id, c.id, ["proxy"]);
    // Vídeo final: só fica no hub perto da hora de publicar (o PC guarda o original e reenvia quando preciso).
    const far = c.scheduled_at && Date.parse(c.scheduled_at) > Date.now() + (FINAL_WINDOW_H + 12) * 3600_000 && !c.schedule_locked;
    if (["PENDING_REVIEW", "FAILED"].includes(c.status) || (c.status === "SCHEDULED" && far)) removeClipFiles(c.job_id, c.id, ["mp4"]);
  }
}

let alerted = false;
function check() {
  try {
    prune();
  } catch (e) {
    console.error("[disco] limpeza:", (e as Error).message);
  }
  const st = diskState();
  if (st.critical && !alerted) {
    alerted = true;
    void tg.alert(
      `💾 Disco do notebook quase cheio: ${st.freeGb} GB livres.\nO worker parou de receber vídeos novos até liberar espaço. ` +
        `Publique/rejeite cortes pendentes ou libere espaço no notebook.`,
    );
  }
  if (!st.critical) alerted = false;
  bus.emit("change", { table: "disk" });
}

export function startDiskGuard() {
  check();
  setInterval(check, 10 * 60_000);
}
