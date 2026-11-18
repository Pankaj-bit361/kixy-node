// Start and stop a throwaway PostgreSQL cluster with the server binaries already on this machine.
// PostgreSQL refuses to run as root, so as root the cluster runs as the `postgres` system user.
import { execFileSync, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** The folder holding initdb and pg_ctl: PG_BIN, then pg_config, then the usual Debian/Ubuntu paths, then PATH. */
export function findPgBin() {
  const candidates = [];
  if (process.env.PG_BIN) candidates.push(process.env.PG_BIN);
  try {
    candidates.push(execFileSync("pg_config", ["--bindir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    // no pg_config on PATH
  }
  candidates.push("/usr/lib/postgresql/16/bin");
  if (existsSync("/usr/lib/postgresql")) {
    const versions = readdirSync("/usr/lib/postgresql").filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) candidates.push(`/usr/lib/postgresql/${v}/bin`);
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir) candidates.push(dir);
  return candidates.find((d) => existsSync(path.join(d, "initdb")) && existsSync(path.join(d, "pg_ctl")));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(bin, args, { quiet = true } = {}) {
  const cmd = isRoot ? "runuser" : bin;
  const argv = isRoot ? ["-u", "postgres", "--", bin, ...args] : args;
  const r = spawnSync(cmd, argv, { encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(bin)} failed:\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  return r.stdout ?? "";
}

/** The postgres user's uid and gid, for handing it the data folder when running as root. */
function postgresIds() {
  const uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim());
  return { uid, gid };
}

export function isInitialized(dataDir) {
  return existsSync(path.join(dataDir, "PG_VERSION"));
}

export function isRunning(bin, dataDir) {
  const cmd = isRoot ? "runuser" : path.join(bin, "pg_ctl");
  const argv = isRoot ? ["-u", "postgres", "--", path.join(bin, "pg_ctl"), "-D", dataDir, "status"] : ["-D", dataDir, "status"];
  return spawnSync(cmd, argv, { stdio: "ignore" }).status === 0;
}

/** Create the cluster if needed and start it on 127.0.0.1:port with trust auth for local connections. */
export function startCluster({ bin, dataDir, port, fast = false }) {
  if (!isInitialized(dataDir)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (isRoot) {
      const { uid, gid } = postgresIds();
      chownSync(dataDir, uid, gid);
    }
    const args = ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C"];
    if (fast) args.push("--no-sync");
    run(path.join(bin, "initdb"), args);
  }
  const opts = [`-p ${port}`, "-c listen_addresses=127.0.0.1", `-c unix_socket_directories=${dataDir}`];
  if (fast) opts.push("-c fsync=off", "-c synchronous_commit=off", "-c full_page_writes=off");
  run(path.join(bin, "pg_ctl"), ["-D", dataDir, "-o", opts.join(" "), "-l", path.join(dataDir, "server.log"), "-w", "-t", "60", "start"]);
  return `postgres://postgres@127.0.0.1:${port}/postgres`;
}

export function stopCluster({ bin, dataDir, remove = false }) {
  try {
    if (isRunning(bin, dataDir)) run(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"]);
  } finally {
    if (remove) rmSync(dataDir, { recursive: true, force: true });
  }
}
