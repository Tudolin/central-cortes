import { config } from "./config.ts";

// Imports dinâmicos: o hub não carrega onnxruntime/SDK da IA e o worker não abre o banco.
if (config.role === "hub" || config.role === "all") {
  await import("./db.ts");
  const { startServer } = await import("./http.ts");
  await import("./hub/api.ts");
  await import("./hub/brandApi.ts");
  const { startReaper } = await import("./hub/workerApi.ts");
  const { startScheduler } = await import("./hub/schedule.ts");
  const { startTelegram } = await import("./hub/telegram.ts");
  const { startDiskGuard } = await import("./hub/disk.ts");
  const { startMetrics } = await import("./hub/metrics.ts");
  startServer();
  // HUB_PASSIVE=1: só serve o painel (prévia local com cópia do banco; nunca publica nada).
  if (process.env.HUB_PASSIVE !== "1") {
    startReaper();
    startScheduler();
    startDiskGuard();
    startMetrics();
    void startTelegram();
  }
}

if (config.role === "worker" || config.role === "all") {
  const { startWorker } = await import("./worker.ts");
  void startWorker();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`${sig} recebido, encerrando.`);
    process.exit(0);
  });
}
