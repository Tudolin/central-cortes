import { config } from "./config.ts";

// Imports dinâmicos: o hub não carrega onnxruntime/SDK da IA e o worker não abre o banco.
if (config.role === "hub" || config.role === "all") {
  await import("./db.ts");
  const { startServer } = await import("./http.ts");
  await import("./hub/api.ts");
  const { startReaper } = await import("./hub/workerApi.ts");
  const { startScheduler } = await import("./hub/schedule.ts");
  const { startTelegram } = await import("./hub/telegram.ts");
  startServer();
  startReaper();
  startScheduler();
  void startTelegram();
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
