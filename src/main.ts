import { createApp } from "./app.js";
import { DEV_JWT_SECRET, loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { errorMessage } from "./errors.js";
import { jobHandlers } from "./handlers.js";
import { JobQueue, type Logger } from "./jobs.js";
import { buildServices } from "./services.js";

const log: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.jwtSecret === DEV_JWT_SECRET) log.warn("JWT_SECRET is not set; using a development secret. Set it before going live.");
  const db = createPool(cfg.databaseUrl);
  const applied = await migrate(db);
  if (applied.length) log.info(`applied migrations: ${applied.join(", ")}`);

  const services = buildServices(cfg);
  const queue = new JobQueue(db, cfg.dataDir, cfg.workerConcurrency, jobHandlers(db, services), log);
  const resumed = await queue.resumeUnfinished();
  if (resumed) log.info(`resumed ${resumed} unfinished job(s)`);

  const app = createApp({ cfg, db, queue, services, log });
  const server = app.listen(cfg.port, cfg.host, () => {
    log.info(`listening on http://${cfg.host}:${cfg.port} (language model: ${services.llm.name}, images: ${services.images.name}, voice: ${services.tts.name})`);
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`${signal}: shutting down`);
    server.close();
    queue
      .stop()
      .then(() => db.end())
      .then(() => process.exit(0))
      .catch((e) => {
        log.error(errorMessage(e));
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error(`could not start: ${errorMessage(e)}`);
  process.exit(1);
});
