import "./db.ts";
import { startServer } from "./server.ts";
import { startWorkers } from "./worker.ts";

startServer();
startWorkers();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`${sig} recebido, encerrando.`);
    process.exit(0);
  });
}
