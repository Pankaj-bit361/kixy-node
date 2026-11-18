// The job queue. Long work runs in the background with a concurrency limit; clients poll
// GET /api/jobs/:id. Jobs live in Postgres, so unfinished ones are picked up again after a restart.
// Each kind of job has a handler; a new kind of work is a new handler.
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { charge, grant } from "./credits.js";
import { withTransaction, type Db } from "./db/pool.js";
import { errorMessage } from "./errors.js";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  user_id: string;
  kind: string;
  status: JobStatus;
  stage: string;
  progress: number;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  cost: number;
  created_at: Date;
  updated_at: Date;
}

export interface JobContext {
  job: Job;
  /** The job's own folder for files. */
  dir: string;
  progress(stage: string, fraction: number): Promise<void>;
  addAsset(kind: string, file: string, meta: Record<string, unknown>): Promise<string>;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export class JobQueue {
  private readonly waiting: string[] = [];
  private running = 0;
  private idleWaiters: (() => void)[] = [];
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly concurrency: number,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    private readonly log: Logger = silentLogger,
  ) {}

  jobDir(id: string): string {
    return path.join(this.dataDir, "jobs", id);
  }

  /**
   * Create a job and charge its cost in one transaction (refunded if the job fails), then queue it.
   * `prepare` runs after the job folder exists and before the job can start, to write its inputs.
   */
  async create(
    userId: string,
    kind: string,
    input: Record<string, unknown>,
    cost: number,
    prepare?: (dir: string) => Promise<void>,
  ): Promise<string> {
    if (!this.handlers[kind]) throw new Error(`no handler for job kind ${kind}`);
    const id = randomUUID();
    const dir = this.jobDir(id);
    await mkdir(dir, { recursive: true });
    try {
      if (prepare) await prepare(dir);
      await withTransaction(this.db, async (tx) => {
        await tx.query("INSERT INTO jobs (id, user_id, kind, status, input, cost) VALUES ($1, $2, $3, 'queued', $4, $5)", [
          id,
          userId,
          kind,
          JSON.stringify(input),
          Math.max(0, cost),
        ]);
        await charge(tx, userId, cost, kind, id);
      });
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    this.enqueue(id);
    return id;
  }

  /** Put jobs left queued or running by an earlier process back in line. */
  async resumeUnfinished(): Promise<number> {
    await this.db.query("UPDATE jobs SET status = 'queued', updated_at = now() WHERE status = 'running'");
    const r = await this.db.query<{ id: string }>("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at");
    for (const row of r.rows) this.enqueue(row.id);
    return r.rowCount ?? 0;
  }

  enqueue(id: string): void {
    if (this.stopped) return;
    this.waiting.push(id);
    this.pump();
  }

  /** Resolves once nothing is running or waiting. */
  idle(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop taking new work and wait for running jobs to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.waiting.length = 0;
    await this.idle();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const id = this.waiting.shift() as string;
      this.running++;
      this.run(id)
        .catch((e) => this.log.error(`job ${id}: runner error: ${errorMessage(e)}`))
        .finally(() => {
          this.running--;
          this.pump();
          if (this.running === 0 && this.waiting.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const w of waiters) w();
          }
        });
    }
  }

  private async run(id: string): Promise<void> {
    const claimed = await this.db.query<Job>(
      "UPDATE jobs SET status = 'running', stage = 'starting', updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING *",
      [id],
    );
    const job = claimed.rows[0];
    if (!job) return; // taken by another worker, or deleted
    const dir = this.jobDir(id);
    await mkdir(dir, { recursive: true });
    const ctx: JobContext = {
      job,
      dir,
      progress: async (stage, fraction) => {
        await this.db.query("UPDATE jobs SET stage = $1, progress = $2, updated_at = now() WHERE id = $3", [
          stage,
          Math.min(1, Math.max(0, fraction)),
          id,
        ]);
      },
      addAsset: async (kind, file, meta) => {
        const assetId = randomUUID();
        await this.db.query("INSERT INTO assets (id, job_id, user_id, kind, file, meta) VALUES ($1, $2, $3, $4, $5, $6)", [
          assetId,
          id,
          job.user_id,
          kind,
          file,
          JSON.stringify(meta),
        ]);
        return assetId;
      },
    };
    this.log.info(`job ${id}: ${job.kind} started`);
    let output: unknown;
    try {
      const handler = this.handlers[job.kind];
      if (!handler) throw new Error(`unknown job kind ${job.kind}`);
      output = await handler(ctx);
    } catch (e) {
      const message = errorMessage(e);
      this.log.warn(`job ${id}: failed: ${message}`);
      await withTransaction(this.db, async (tx) => {
        const r = await tx.query<{ cost: number }>(
          "UPDATE jobs SET status = 'failed', stage = 'failed', error = $1, updated_at = now() WHERE id = $2 RETURNING cost",
          [message, id],
        );
        const cost = r.rows[0]?.cost ?? 0;
        await grant(tx, job.user_id, cost, "refund: job failed", id);
      });
      return;
    }
    await this.db.query(
      "UPDATE jobs SET status = 'done', stage = 'done', progress = 1, output = $1, updated_at = now() WHERE id = $2",
      [JSON.stringify(output ?? null), id],
    );
    this.log.info(`job ${id}: done`);
  }
}
