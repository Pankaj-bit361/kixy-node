import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "../src/auth.js";
import { balance } from "../src/credits.js";
import { JobQueue, type JobHandler } from "../src/jobs.js";
import { freshDatabase, services, skipWithoutDb, startServer, type TestDb } from "./helpers.js";

async function user(tdb: TestDb, credits: number): Promise<string> {
  const id = randomUUID();
  await tdb.db.query("INSERT INTO users (id, email, password_hash, credits) VALUES ($1, $2, $3, $4)", [
    id,
    `${id}@example.com`,
    await hashPassword("password1"),
    credits,
  ]);
  return id;
}

describe("job queue", { skip: skipWithoutDb }, () => {
  let tdb: TestDb;
  let dataDir: string;
  before(async () => {
    tdb = await freshDatabase();
    dataDir = await mkdtemp(path.join(os.tmpdir(), "kixy-queue-"));
  });
  after(async () => {
    await tdb?.drop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("a job that fails is marked failed and its credits come back", async () => {
    const failing: JobHandler = async (ctx) => {
      await ctx.progress("halfway", 0.5);
      throw new Error("the provider is down");
    };
    const s = await startServer(tdb.db, services(), { extraHandlers: { images: failing } });
    try {
      const { token } = await s.signup();
      const res = await s.call("POST", "/api/images", { token, body: { prompt: "x", count: 3 } });
      const job = (await s.settled(res.json.job_id, token)).json;
      assert.equal(job.status, "failed");
      assert.equal(job.error, "the provider is down");
      assert.equal((await s.call("GET", "/api/me", { token })).json.credits, 60);
      const ledger = (await s.call("GET", "/api/credits/ledger", { token })).json;
      assert.deepEqual(
        ledger.map((r: { delta: number; reason: string }) => [r.delta, r.reason]),
        [
          [3, "refund: job failed"],
          [-3, "images"],
          [60, "welcome credits"],
        ],
      );
    } finally {
      await s.close();
    }
  });

  test("jobs left over by an earlier process are run on start", async () => {
    const uid = await user(tdb, 10);
    const ids = [randomUUID(), randomUUID()];
    await tdb.db.query("INSERT INTO jobs (id, user_id, kind, status, input, cost) VALUES ($1, $3, 'echo', 'running', '{\"n\":1}', 0), ($2, $3, 'echo', 'queued', '{\"n\":2}', 0)", [
      ...ids,
      uid,
    ]);
    const seen: number[] = [];
    const echo: JobHandler = async (ctx) => {
      seen.push(ctx.job.input.n as number);
      return { n: ctx.job.input.n };
    };
    const queue = new JobQueue(tdb.db, dataDir, 1, { echo });
    assert.equal(await queue.resumeUnfinished(), 2);
    await queue.idle();
    assert.deepEqual(seen.sort(), [1, 2]);
    const rows = await tdb.db.query<{ status: string; output: { n: number } }>("SELECT status, output FROM jobs WHERE id = ANY($1) ORDER BY output->>'n'", [ids]);
    assert.deepEqual(
      rows.rows.map((r) => [r.status, r.output.n]),
      [
        ["done", 1],
        ["done", 2],
      ],
    );
    await queue.stop();
  });

  test("concurrency is limited and every job finishes", async () => {
    const uid = await user(tdb, 100);
    let running = 0;
    let peak = 0;
    const slow: JobHandler = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return null;
    };
    const queue = new JobQueue(tdb.db, dataDir, 2, { slow });
    const ids = await Promise.all(Array.from({ length: 6 }, () => queue.create(uid, "slow", {}, 1)));
    await queue.idle();
    assert.equal(peak, 2);
    const done = await tdb.db.query("SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND status = 'done'", [ids]);
    assert.equal(done.rows[0].n, 6);
    assert.equal(await balance(tdb.db, uid), 94);
    await queue.stop();
  });

  test("charging is all or nothing", async () => {
    const uid = await user(tdb, 2);
    const queue = new JobQueue(tdb.db, dataDir, 1, { slow: async () => null });
    await assert.rejects(queue.create(uid, "slow", {}, 3), (e: { status?: number }) => e.status === 402);
    const jobs = await tdb.db.query("SELECT count(*)::int AS n FROM jobs WHERE user_id = $1", [uid]);
    assert.equal(jobs.rows[0].n, 0);
    assert.equal(await balance(tdb.db, uid), 2);
    await assert.rejects(queue.create(uid, "nope", {}, 0), /no handler/);
    await queue.stop();
  });
});
