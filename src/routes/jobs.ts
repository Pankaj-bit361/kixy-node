import { rm } from "node:fs/promises";
import path from "node:path";
import { Router, type Request } from "express";
import { requireUser, userOf } from "../auth.js";
import type { Config } from "../config.js";
import { withTransaction, type Db } from "../db/pool.js";
import { AppError } from "../errors.js";
import type { Job, JobQueue } from "../jobs.js";
import type { Word } from "../types.js";
import { applyEdit, clipJson, EditError, FILES, readJson, saveEdit, type ClipEdit, type ClipRow, type SourceInfo } from "../pipelines/clipper.js";
import { body, handle, idParam, safeName } from "./util.js";

function jobJson(j: Job): Record<string, unknown> {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    stage: j.stage,
    progress: j.progress,
    input: j.input,
    output: j.output,
    error: j.error,
    cost: j.cost,
    created_at: j.created_at,
    updated_at: j.updated_at,
  };
}

const UNKNOWN_SOURCE: SourceInfo = { name: "", duration: Number.POSITIVE_INFINITY, size: null };

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate a PATCH /clips/:id body. */
export function parseClipEdit(b: Record<string, unknown>): ClipEdit {
  const e: ClipEdit = {};
  const bad = (field: string, what: string) => AppError.badRequest(`${field} must be ${what}`);
  for (const k of ["title", "hook", "crop_mode", "caption_style"] as const) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== "string") throw bad(k, "text");
      e[k] = b[k] as string;
    }
  }
  for (const k of ["start", "end", "crop_x"] as const) {
    if (b[k] !== undefined) {
      if (!isNum(b[k])) throw bad(k, "a number");
      e[k] = b[k] as number;
    }
  }
  if (b.show_hook !== undefined) {
    if (typeof b.show_hook !== "boolean") throw bad("show_hook", "true or false");
    e.show_hook = b.show_hook;
  }
  if (b.words !== undefined) {
    const ok = Array.isArray(b.words) && b.words.every((w) => w && isNum(w.start) && isNum(w.end) && typeof w.text === "string" && w.end >= w.start);
    if (!ok) throw bad("words", "a list of {start, end, text}");
    e.words = (b.words as Word[]).map((w) => ({ start: w.start, end: w.end, text: w.text }));
  }
  return e;
}

export function jobRoutes(db: Db, cfg: Config, queue: JobQueue): Router {
  const r = Router();
  const auth = requireUser(cfg.jwtSecret);
  const font = cfg.captionFont;

  async function ownJob(req: Request): Promise<Job> {
    const j = (await db.query<Job>("SELECT * FROM jobs WHERE id = $1 AND user_id = $2", [idParam(req), userOf(req).id])).rows[0];
    if (!j) throw AppError.notFound();
    return j;
  }

  async function ownClip(req: Request): Promise<ClipRow> {
    const c = (await db.query<ClipRow>("SELECT * FROM clips WHERE id = $1 AND user_id = $2", [idParam(req), userOf(req).id])).rows[0];
    if (!c) throw AppError.notFound();
    return c;
  }

  const sourceOf = (jobId: string) => readJson<SourceInfo>(queue.jobDir(jobId), FILES.source, UNKNOWN_SOURCE);

  r.get(
    "/jobs",
    auth,
    handle(async (req) => {
      const kind = typeof req.query.kind === "string" ? req.query.kind : null;
      const rows = await db.query<Job & { thumb: string | null }>(
        `SELECT j.*, (SELECT a.file FROM assets a WHERE a.job_id = j.id AND a.kind IN ('image', 'page')
                      ORDER BY a.created_at LIMIT 1) AS thumb
           FROM jobs j WHERE j.user_id = $1 AND ($2::text IS NULL OR j.kind = $2)
          ORDER BY j.created_at DESC, j.id LIMIT 100`,
        [userOf(req).id, kind],
      );
      return rows.rows.map((j) => ({ ...jobJson(j), thumb: j.thumb }));
    }),
  );

  r.get(
    "/jobs/:id",
    auth,
    handle(async (req) => {
      const job = await ownJob(req);
      const clips = (await db.query<ClipRow>("SELECT * FROM clips WHERE job_id = $1 ORDER BY score DESC, idx", [job.id])).rows;
      const assets = (await db.query("SELECT id, kind, file, meta FROM assets WHERE job_id = $1 ORDER BY created_at, id", [job.id])).rows;
      const source = clips.length ? await sourceOf(job.id) : UNKNOWN_SOURCE;
      return { ...jobJson(job), clips: clips.map((c) => clipJson(c, source)), assets };
    }),
  );

  r.delete(
    "/jobs/:id",
    auth,
    handle(async (req) => {
      const job = await ownJob(req);
      if (job.status === "running") throw AppError.conflict("wait for this job to finish first");
      await withTransaction(db, async (tx) => {
        await tx.query("UPDATE credit_ledger SET job_id = NULL WHERE job_id = $1", [job.id]);
        await tx.query("DELETE FROM jobs WHERE id = $1", [job.id]);
      });
      await rm(queue.jobDir(job.id), { recursive: true, force: true });
      return { deleted: job.id };
    }),
  );

  r.get(
    "/jobs/:id/transcript",
    auth,
    handle(async (req) => {
      const job = await ownJob(req);
      return readJson<Word[]>(queue.jobDir(job.id), FILES.transcript, []);
    }),
  );

  // Files support Range requests (sendFile handles them).
  r.get(
    "/jobs/:id/files/:name",
    auth,
    handle(async (req, res) => {
      const name = String(req.params.name);
      if (!safeName(name)) throw AppError.notFound();
      const job = await ownJob(req);
      const file = path.join(queue.jobDir(job.id), name);
      if (req.query.download === "1") res.attachment(name);
      await new Promise<void>((resolve, reject) =>
        res.sendFile(file, { dotfiles: "deny" }, (err) => {
          if (!err) return resolve();
          if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as { status?: number }).status === 404) return reject(AppError.notFound());
          reject(err);
        }),
      );
    }),
  );

  r.get(
    "/clips/:id",
    auth,
    handle(async (req) => {
      const c = await ownClip(req);
      return clipJson(c, await sourceOf(c.job_id));
    }),
  );

  // Save edits. Changes to what the captions show write a new caption file under a new version.
  r.patch(
    "/clips/:id",
    auth,
    handle(async (req) => {
      const before = await ownClip(req);
      const edit = parseClipEdit(body(req));
      const dir = queue.jobDir(before.job_id);
      const source = await sourceOf(before.job_id);
      try {
        const { clip, recaption } = await applyEdit(before, edit, source.duration, () => readJson<Word[]>(dir, FILES.transcript, []));
        const saved = await saveEdit(db, dir, before, clip, recaption, font);
        return { clip: clipJson(saved, source) };
      } catch (e) {
        if (e instanceof EditError) throw AppError.badRequest(e.message);
        throw e;
      }
    }),
  );

  return r;
}
