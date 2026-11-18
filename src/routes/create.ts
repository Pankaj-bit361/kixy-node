// Endpoints that start work. Each returns `{ job_id }`; poll GET /api/jobs/:id.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Router, type Request } from "express";
import { requireUser, userOf } from "../auth.js";
import type { Config } from "../config.js";
import { clipCost, PRICE } from "../credits.js";
import { AppError } from "../errors.js";
import type { JobQueue } from "../jobs.js";
import { parseTranscript } from "../media/transcript.js";
import { FILES, parseClipOptions, type SourceInfo } from "../pipelines/clipper.js";
import { clampInt } from "../pipelines/services.js";
import { body, handle, requireText } from "./util.js";

const MAX_LOUDNESS = 6 * 3600;

function parseLoudness(v: unknown): number[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_LOUDNESS || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) {
    throw AppError.badRequest(`loudness must be a list of at most ${MAX_LOUDNESS} non-negative numbers, one per second`);
  }
  return v as number[];
}

function parseSize(v: unknown): SourceInfo["size"] {
  if (v === undefined || v === null) return null;
  const s = v as { width?: unknown; height?: unknown };
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 16 && n <= 16384;
  if (!ok(s.width) || !ok(s.height)) throw AppError.badRequest("source width and height must be whole pixels");
  return { width: s.width, height: s.height };
}

/** Validate a clipper request into what the job needs. */
export function clipperRequest(b: Record<string, unknown>) {
  const words = b.transcript === undefined ? [] : parseTranscript(b.transcript, typeof b.format === "string" ? b.format : undefined);
  const loudness = parseLoudness(b.loudness);
  const lastWord = words.length ? words[words.length - 1].end : 0;
  const given = typeof b.duration === "number" && Number.isFinite(b.duration) ? b.duration : undefined;
  if (given !== undefined && (given <= 0 || given > 12 * 3600)) throw AppError.badRequest("duration must be between 0 and 12 hours");
  const duration = Math.max(given ?? 0, lastWord, loudness.length);
  if (words.length === 0 && loudness.length === 0) throw AppError.badRequest("add a transcript (or per-second loudness) to find clips in");
  if (duration < 1) throw AppError.badRequest("the video must be at least a second long");
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 200) : "Untitled";
  const source: SourceInfo = { name, duration, size: parseSize(b.source) };
  return { words, loudness, source, options: parseClipOptions(b.options) };
}

export function createRoutes(cfg: Config, queue: JobQueue): Router {
  const r = Router();
  const auth = requireUser(cfg.jwtSecret);
  const user = (req: Request) => userOf(req).id;

  r.post(
    "/clipper",
    auth,
    handle(async (req) => {
      const { words, loudness, source, options } = clipperRequest(body(req));
      const jobId = await queue.create(
        user(req),
        "clip",
        { name: source.name, duration: source.duration, options, transcript_words: words.length },
        clipCost(source.duration),
        async (dir) => {
          await writeFile(path.join(dir, FILES.source), JSON.stringify(source));
          await writeFile(path.join(dir, FILES.transcript), JSON.stringify(words));
          if (loudness.length) await writeFile(path.join(dir, FILES.loudness), JSON.stringify(loudness));
        },
      );
      return { job_id: jobId };
    }),
  );

  r.post(
    "/storyboard",
    auth,
    handle(async (req) => {
      const b = body(req);
      requireText(b.prompt, "write an idea for the video");
      return { job_id: await queue.create(user(req), "storyboard", b, PRICE.storyboard) };
    }),
  );

  r.post(
    "/images",
    auth,
    handle(async (req) => {
      const b = body(req);
      requireText(b.prompt, "describe the image");
      const n = clampInt(b.count, 1, 4, 1);
      return { job_id: await queue.create(user(req), "images", b, n * PRICE.image) };
    }),
  );

  r.post(
    "/coloring",
    auth,
    handle(async (req) => {
      const b = body(req);
      requireText(b.theme, "give the book a theme");
      const n = clampInt(b.pages, 1, 30, 8);
      return { job_id: await queue.create(user(req), "coloring", b, n * PRICE.coloringPage) };
    }),
  );

  return r;
}
