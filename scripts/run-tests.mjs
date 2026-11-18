// Run the compiled tests. Database tests use TEST_DATABASE_URL (a server URL; each test file
// creates and drops its own database) or, if that is not set, a throwaway PostgreSQL cluster
// started here from the server programs on this machine.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPgBin, freePort, startCluster, stopCluster } from "./pg.mjs";

function testFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...testFiles(p));
    else if (name.endsWith(".test.js")) out.push(p);
  }
  return out.sort();
}

const files = testFiles(path.resolve("dist/test"));
if (files.length === 0) {
  console.error("No compiled tests in dist/test. Run npm run build first.");
  process.exit(1);
}

const env = { ...process.env };
let cluster;
if (!env.TEST_DATABASE_URL) {
  const bin = findPgBin();
  if (bin) {
    const parent = mkdtempSync(path.join(os.tmpdir(), "kixy-test-pg-"));
    chmodSync(parent, 0o755); // so the postgres user can reach the data folder when this runs as root
    const dataDir = path.join(parent, "data");
    const port = await freePort();
    try {
      env.TEST_DATABASE_URL = startCluster({ bin, dataDir, port, fast: true });
      cluster = { bin, dataDir };
      console.log(`Started a temporary PostgreSQL on port ${port} for the tests.`);
    } catch (e) {
      console.warn(`\n!!! Could not start a temporary PostgreSQL, so database tests will be skipped:\n${e instanceof Error ? e.message : e}\n`);
    }
  } else {
    console.warn("\n!!! No PostgreSQL server programs found and TEST_DATABASE_URL is not set: database tests will be skipped.\n");
  }
}

let status = 1;
try {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit", env });
  status = r.status ?? 1;
} finally {
  if (cluster) {
    try {
      stopCluster({ ...cluster, remove: true });
      rmSync(path.dirname(cluster.dataDir), { recursive: true, force: true });
    } catch (e) {
      console.warn(`could not stop the temporary PostgreSQL: ${e instanceof Error ? e.message : e}`);
    }
  }
}
process.exit(status);
