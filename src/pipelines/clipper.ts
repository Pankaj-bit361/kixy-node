// A long talk's transcript -> scored clip plans, each with burn-in captions and a render spec
// (time range, 9:16 framing, caption file) that a video renderer can carry out.
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { finalize, pickHeuristic, pickWithLlm, sanitizePickOptions } from "../ai/highlights.js";
import type { Db, Queryable } from "../db/pool.js";
import { errorMessage } from "../errors.js";
import type { JobContext, JobHandler } from "../jobs.js";
import { buildAss, parseCaptionStyle, type CaptionStyle } from "../media/captions.js";
import { framing, OUTPUT, parseCropMode, type CropMode, type Framing, type SourceSize } from "../media/framing.js";
import { wordsIn, type ClipPlan, type Word } from "../types.js";
import { num, type Services } from "./services.js";

export interface ClipOptions {
  count: number;
  min_len: number;
  max_len: number;
  caption_style: CaptionStyle;
  crop_mode: CropMode;
  show_hook: boolean;
}

export function parseClipOptions(raw: unknown): ClipOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = sanitizePickOptions({ count: num(o.count, 10), minLen: num(o.min_len, 15), maxLen: num(o.max_len, 60) });
  return {
    count: pick.count,
    min_len: pick.minLen,
    max_len: pick.maxLen,
    caption_style: parseCaptionStyle(o.caption_style),
    crop_mode: parseCropMode(o.crop_mode),
    show_hook: typeof o.show_hook === "boolean" ? o.show_hook : true,
  };
}

/** What the clipper knows about the source video; written to source.json. */
export interface SourceInfo {
  name: string;
  duration: number;
  size: SourceSize | null;
}

export const FILES = { source: "source.json", transcript: "transcript.json", loudness: "loudness.json" } as const;

export async function readJson<T>(dir: string, file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path.join(dir, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export interface ClipRow {
  id: string;
  job_id: string;
  user_id: string;
  idx: number;
  title: string;
  hook: string;
  score: number;
  reason: string;
  start_s: number;
  end_s: number;
  crop_mode: CropMode;
  crop_x: number;
  caption_style: CaptionStyle;
  show_hook: boolean;
  words: Word[];
  captions: string;
  version: number;
  created_at: Date;
}

export function captionsName(idx: number, version: number): string {
  return `clip_${idx}_v${version}.ass`;
}

export function captionsFor(clip: Pick<ClipRow, "words" | "start_s" | "end_s" | "caption_style" | "show_hook" | "hook">, font: string): string {
  const hook = clip.show_hook && clip.hook.trim() ? clip.hook : undefined;
  return buildAss(clip.words, clip.start_s, clip.end_s, { style: clip.caption_style, font, hook });
}

/** Everything a renderer needs to cut this clip from the source. */
export interface RenderSpec {
  source: string;
  start: number;
  end: number;
  output: typeof OUTPUT;
  /** null when the source frame size is not known. */
  framing: Framing | null;
  captions: string;
}

export function renderSpec(clip: ClipRow, source: SourceInfo): RenderSpec {
  return {
    source: source.name,
    start: clip.start_s,
    end: clip.end_s,
    output: OUTPUT,
    framing: source.size ? framing(source.size, clip.crop_mode, clip.crop_x) : null,
    captions: clip.captions,
  };
}

export function clipJson(c: ClipRow, source: SourceInfo): Record<string, unknown> {
  return {
    id: c.id,
    job_id: c.job_id,
    idx: c.idx,
    title: c.title,
    hook: c.hook,
    score: c.score,
    reason: c.reason,
    start: c.start_s,
    end: c.end_s,
    duration: c.end_s - c.start_s,
    crop_mode: c.crop_mode,
    crop_x: c.crop_x,
    caption_style: c.caption_style,
    show_hook: c.show_hook,
    words: c.words,
    captions: c.captions,
    version: c.version,
    render: renderSpec(c, source),
  };
}

async function choosePlans(
  services: Services,
  words: Word[],
  loudness: number[],
  source: SourceInfo,
  opts: ClipOptions,
  notes: string[],
): Promise<{ plans: ClipPlan[]; picker: string }> {
  const pick = { count: opts.count, minLen: opts.min_len, maxLen: opts.max_len };
  if (services.llm.available && words.length >= 10) {
    try {
      const plans = await pickWithLlm(services.llm, words, source.duration, pick);
      const kept = finalize(plans, words, source.duration, pick);
      if (kept.length > 0) return { plans: kept, picker: services.llm.name };
      notes.push("The model returned no usable clips; used the built-in picker.");
    } catch (e) {
      notes.push(`Model unavailable (${errorMessage(e)}); used the built-in picker.`);
    }
  }
  const plans = finalize(pickHeuristic(words, loudness, source.duration, pick), words, source.duration, pick);
  return { plans, picker: "heuristic" };
}

export function clipperHandler(db: Db, services: Services): JobHandler {
  return async (ctx: JobContext) => {
    const opts = parseClipOptions(ctx.job.input.options);
    const source = await readJson<SourceInfo | null>(ctx.dir, FILES.source, null);
    if (!source) throw new Error("the source details for this job are missing");
    const words = await readJson<Word[]>(ctx.dir, FILES.transcript, []);
    const loudness = await readJson<number[]>(ctx.dir, FILES.loudness, []);
    const notes: string[] = [];
    if (words.length === 0) notes.push("No transcript was given, so clips are picked from loudness and have no captions.");

    await ctx.progress("finding the best moments", 0.2);
    const { plans, picker } = await choosePlans(services, words, loudness, source, opts, notes);
    if (plans.length === 0) throw new Error("no clip-worthy moments found");

    await ctx.progress("writing captions", 0.7);
    for (const [i, plan] of plans.entries()) {
      const idx = i + 1;
      const row = {
        words: wordsIn(words, plan.start, plan.end),
        start_s: plan.start,
        end_s: plan.end,
        caption_style: opts.caption_style,
        show_hook: opts.show_hook,
        hook: plan.hook,
      };
      const captions = captionsName(idx, 1);
      await writeFile(path.join(ctx.dir, captions), captionsFor(row, services.captionFont));
      await db.query(
        `INSERT INTO clips (id, job_id, user_id, idx, title, hook, score, reason, start_s, end_s, crop_mode, crop_x,
                            caption_style, show_hook, words, captions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0.5, $12, $13, $14, $15)`,
        [
          randomUUID(), ctx.job.id, ctx.job.user_id, idx, plan.title, plan.hook, plan.score, plan.reason,
          plan.start, plan.end, opts.crop_mode, opts.caption_style, opts.show_hook, JSON.stringify(row.words), captions,
        ],
      );
    }
    return { clips: plans.length, duration: source.duration, transcript_words: words.length, picker, notes };
  };
}

export interface ClipEdit {
  title?: string;
  hook?: string;
  start?: number;
  end?: number;
  crop_mode?: string;
  crop_x?: number;
  caption_style?: string;
  show_hook?: boolean;
  /** Edited caption words (absolute times). Omit to keep them or, after a trim, re-read the transcript. */
  words?: Word[];
}

export class EditError extends Error {}

/**
 * Apply an edit to a clip. Returns the new row and whether its captions changed (and so need a
 * new caption file and version). `transcript` is read only when a trim needs it.
 */
export async function applyEdit(
  clip: ClipRow,
  edit: ClipEdit,
  duration: number,
  transcript: () => Promise<Word[]>,
): Promise<{ clip: ClipRow; recaption: boolean }> {
  const c: ClipRow = { ...clip };
  let recaption = false;
  if (edit.title !== undefined) c.title = Array.from(edit.title).slice(0, 120).join("");
  if (edit.hook !== undefined) {
    const hook = Array.from(edit.hook).slice(0, 80).join("");
    recaption ||= hook !== c.hook;
    c.hook = hook;
  }
  const trimmed = edit.start !== undefined || edit.end !== undefined;
  if (trimmed) {
    const s = Math.max(edit.start ?? c.start_s, 0);
    const e = Math.min(edit.end ?? c.end_s, duration);
    if (e - s < 1 || e - s > 180) throw new EditError("a clip must be between 1 second and 3 minutes");
    recaption ||= Math.abs(s - c.start_s) > 0.01 || Math.abs(e - c.end_s) > 0.01;
    c.start_s = s;
    c.end_s = e;
  }
  if (edit.crop_mode !== undefined) c.crop_mode = parseCropMode(edit.crop_mode);
  if (edit.crop_x !== undefined) c.crop_x = Math.min(1, Math.max(0, edit.crop_x));
  if (edit.caption_style !== undefined) {
    const style = parseCaptionStyle(edit.caption_style);
    recaption ||= style !== c.caption_style;
    c.caption_style = style;
  }
  if (edit.show_hook !== undefined) {
    recaption ||= edit.show_hook !== c.show_hook;
    c.show_hook = edit.show_hook;
  }
  if (edit.words !== undefined) {
    c.words = wordsIn(edit.words, c.start_s, c.end_s);
    recaption = true;
  } else if (trimmed) {
    c.words = wordsIn(await transcript(), c.start_s, c.end_s);
  }
  return { clip: c, recaption };
}

/** Save an edited clip; a caption change writes a new caption file under a new version. */
export async function saveEdit(db: Queryable, dir: string, before: ClipRow, after: ClipRow, recaption: boolean, font: string): Promise<ClipRow> {
  const c = { ...after };
  if (recaption) {
    c.version = before.version + 1;
    c.captions = captionsName(c.idx, c.version);
    await writeFile(path.join(dir, c.captions), captionsFor(c, font));
  }
  await db.query(
    `UPDATE clips SET title = $1, hook = $2, start_s = $3, end_s = $4, crop_mode = $5, crop_x = $6, caption_style = $7,
                      show_hook = $8, words = $9, captions = $10, version = $11 WHERE id = $12`,
    [c.title, c.hook, c.start_s, c.end_s, c.crop_mode, c.crop_x, c.caption_style, c.show_hook, JSON.stringify(c.words), c.captions, c.version, c.id],
  );
  if (recaption && before.captions !== c.captions) await rm(path.join(dir, before.captions), { force: true });
  return c;
}
