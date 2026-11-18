// A PostgreSQL server for development, kept in .pgdata (or PGDATA_DIR).
//   npm run db:local        start it (creating it the first time)
//   npm run db:local:stop   stop it
import path from "node:path";
import { findPgBin, isRunning, startCluster, stopCluster } from "./pg.mjs";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
// As root the server runs as the postgres user, which may not be able to reach a folder under root's home.
const dataDir = path.resolve(process.env.PGDATA_DIR ?? (isRoot ? "/var/tmp/kixy-pgdata" : ".pgdata"));
const port = Number(process.env.PGPORT ?? 5432);
const command = process.argv[2] ?? "start";

const bin = findPgBin();
if (!bin) {
  console.error("Could not find the PostgreSQL server programs (initdb, pg_ctl). Set PG_BIN to their folder, e.g. /usr/lib/postgresql/16/bin.");
  process.exit(1);
}

try {
  if (command === "stop") {
    stopCluster({ bin, dataDir });
    console.log("PostgreSQL stopped.");
  } else if (isRunning(bin, dataDir)) {
    console.log(`PostgreSQL is already running from ${dataDir}.`);
  } else {
    const url = startCluster({ bin, dataDir, port });
    console.log(`PostgreSQL is running from ${dataDir} on port ${port}.`);
    console.log(`Use DATABASE_URL=${url.replace(/\/postgres$/, "/kixy")} and run npm run db:setup.`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
