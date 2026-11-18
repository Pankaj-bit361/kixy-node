// Choosing the moments worth clipping. With a language model, it reads the timed transcript and
// picks self-contained moments with a strong opening. Without one, a heuristic scores windows by
// speech density, hook words and (when given) loudness.
import { segments, type ClipPlan, type Segment, type Word } from "../types.js";
import type { JsonSchema, Llm } from "./llm.js";

export interface PickOptions {
  count: number;
  minLen: number;
  maxLen: number;
}

export function sanitizePickOptions(o: Partial<PickOptions>): PickOptions {
  const count = clampInt(o.count ?? 10, 1, 20);
  const minLen = clampNum(o.minLen ?? 15, 5, 170);
  const maxLen = clampNum(o.maxLen ?? 60, minLen + 1, 180);
  return { count, minLen, maxLen };
}

function clampNum(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.round(clampNum(n, lo, hi));
}

export const SYSTEM_PROMPT =
  "You are a senior short-form video editor. You find the moments in long videos that work " +
  "as standalone vertical clips for TikTok, Reels and Shorts. A good clip makes sense without the rest of the video, " +
  "opens on a line that stops the scroll (a bold claim, a question, a surprise, a strong emotion), and ends on a payoff, " +
  "not mid-thought. You never invent words that are not in the transcript.";

export const PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "title", "hook", "score", "reason"],
        properties: {
          start: { type: "number", description: "seconds, the start of a transcript line" },
          end: { type: "number", description: "seconds, the end of a transcript line" },
          title: { type: "string", description: "short title for the clip, max 60 characters" },
          hook: { type: "string", description: "on-screen hook text shown in the first seconds, max 7 words" },
          score: { type: "integer", description: "0-100, how likely this clip is to perform" },
          reason: { type: "string", description: "one sentence on why it works" },
        },
      },
    },
  },
};

export function buildPrompt(segs: readonly Segment[], duration: number, opts: PickOptions): string {
  const lines = segs.map((s) => `[${s.start.toFixed(1)} - ${s.end.toFixed(1)}] ${s.text}\n`).join("");
  return (
    `The video is ${duration.toFixed(0)} seconds long. Its transcript, one line per sentence with start and end seconds:\n\n${lines}\n` +
    `Pick up to ${opts.count} clips, each between ${opts.minLen.toFixed(0)} and ${opts.maxLen.toFixed(0)} seconds long, that do not overlap. ` +
    "Start each clip at the start of a line and end it at the end of a line. " +
    "Order them from best to worst and score them honestly: most clips should not get 90+."
  );
}

export async function pickWithLlm(llm: Llm, words: readonly Word[], duration: number, opts: PickOptions): Promise<ClipPlan[]> {
  const prompt = buildPrompt(segments(words, 0.9, 20), duration, opts);
  return parsePlans(await llm.json(SYSTEM_PROMPT, prompt, PLAN_SCHEMA));
}

function chars(s: unknown, max: number): string {
  return typeof s === "string" ? Array.from(s).slice(0, max).join("") : "";
}

/** Keep the well-formed clips from a model answer; drop the rest. */
export function parsePlans(v: unknown): ClipPlan[] {
  const clips = (v as { clips?: unknown } | null)?.clips;
  if (!Array.isArray(clips)) return [];
  const out: ClipPlan[] = [];
  for (const c of clips as Record<string, unknown>[]) {
    if (typeof c?.start !== "number" || typeof c?.end !== "number") continue;
    const score = typeof c.score === "number" ? Math.round(c.score) : 50;
    out.push({
      start: c.start,
      end: c.end,
      title: chars(c.title, 80),
      hook: chars(c.hook, 60),
      score: Math.min(100, Math.max(0, score)),
      reason: chars(c.reason, 300),
    });
  }
  return out;
}

const HOOK_WORDS = new Set([
  "how", "why", "secret", "never", "always", "mistake", "truth", "best", "worst", "stop", "nobody", "everyone",
  "crazy", "insane", "wrong", "actually", "money", "free", "first", "biggest", "imagine", "shocking", "hack",
]);

function stripPunct(t: string, keepApostrophe: boolean): string {
  const re = keepApostrophe ? /^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu : /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
  return t.replace(re, "");
}

export function hookFrom(words: readonly Word[]): string {
  return words
    .slice(0, 7)
    .map((w) => stripPunct(w.text, true))
    .join(" ");
}

export function titleFrom(words: readonly Word[]): string {
  let s = "";
  for (const w of words.slice(0, 14)) {
    if (s) s += " ";
    s += w.text.trim();
    if (/[.?!]$/.test(w.text) && s.length > 20) break;
  }
  s = s.replace(/[,;]+$/, "");
  const cs = Array.from(s);
  return cs.length > 60 ? `${cs.slice(0, 57).join("")}...` : s;
}

function mean(v: readonly number[]): number {
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
}

function byScore(a: ClipPlan, b: ClipPlan): number {
  return b.score - a.score;
}

function clock(t: number): string {
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Fallback picker. `loudness` is RMS per second and may be empty. */
export function pickHeuristic(words: readonly Word[], loudness: readonly number[], duration: number, opts: PickOptions): ClipPlan[] {
  const target = Math.min((opts.minLen + opts.maxLen) / 2, duration);
  const globalLoud = Math.max(mean(loudness), 1e-6);
  const loudAt = (s: number, e: number): number => {
    const a = Math.min(Math.floor(Math.max(s, 0)), loudness.length);
    const b = Math.min(Math.ceil(e), loudness.length);
    return mean(loudness.slice(a, Math.max(a, b))) / globalLoud;
  };
  const cands: ClipPlan[] = [];
  if (words.length >= 4) {
    const segs = segments(words, 0.9, 20);
    segs.forEach((s, i) => {
      // Grow from this sentence until the clip is long enough.
      let j = i;
      while (j + 1 < segs.length && segs[j].end - s.start < target) j++;
      const end = segs[j].end;
      const len = end - s.start;
      if (len < Math.min(opts.minLen, duration * 0.9) || len > opts.maxLen + 5) return;
      const ws = words.filter((w) => w.start >= s.start && w.end <= end + 0.01);
      const wps = ws.length / Math.max(len, 1);
      const hookHits = ws.slice(0, 12).filter((w) => HOOK_WORDS.has(stripPunct(w.text.toLowerCase(), false))).length;
      const question = s.text.includes("?") ? 1 : 0;
      const exclaim = ws.filter((w) => w.text.endsWith("!")).length;
      const endsClean = /[.!?]$/.test(segs[j].text.trimEnd()) ? 1 : 0;
      const score =
        30 +
        Math.min(wps / 3, 1) * 25 +
        Math.min(hookHits * 8, 20) +
        question * 8 +
        Math.min(exclaim, 3) * 3 +
        endsClean * 5 +
        Math.min(10, Math.max(-10, (loudAt(s.start, end) - 1) * 20));
      const reasons: string[] = [];
      if (hookHits > 0 || question > 0) reasons.push("opens with a hook");
      if (wps > 2.2) reasons.push("dense, fast talk");
      if (exclaim > 0) reasons.push("high energy");
      if (reasons.length === 0) reasons.push("complete thought");
      cands.push({
        start: s.start,
        end,
        title: titleFrom(ws),
        hook: hookFrom(ws),
        score: Math.min(100, Math.max(0, Math.round(score))),
        reason: `Picked automatically: ${reasons.join(", ")}.`,
      });
    });
  } else {
    // No transcript: look for the liveliest stretches of audio.
    for (let t = 0; t + target <= duration + 0.01; t += 2) {
      const end = Math.min(t + target, duration);
      cands.push({
        start: t,
        end,
        title: `Moment at ${clock(t)}`,
        hook: "",
        score: Math.min(100, Math.max(0, Math.round(35 + (loudAt(t, end) - 1) * 40))),
        reason: "Picked from audio energy (no transcript available).",
      });
    }
    if (cands.length === 0 && duration > 1) {
      cands.push({ start: 0, end: duration, title: "Full video", hook: "", score: 40, reason: "Video is shorter than the clip length." });
    }
  }
  return cands.sort(byScore);
}

/** How much two clips share, as a fraction of the shorter one. */
export function overlap(a: ClipPlan, b: ClipPlan): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter / Math.max(Math.min(a.end - a.start, b.end - b.start), 0.01);
}

/** Clamp, snap to word edges, drop overlaps, keep the best `count`. */
export function finalize(plans: readonly ClipPlan[], words: readonly Word[], duration: number, opts: PickOptions): ClipPlan[] {
  const out: ClipPlan[] = [];
  for (const orig of [...plans].sort(byScore)) {
    const p = { ...orig };
    p.start = Math.min(Math.max(p.start, 0), duration);
    p.end = Math.min(Math.max(p.end, 0), duration);
    if (p.end <= p.start) continue;
    if (words.length > 0) {
      const first = words.find((w) => w.end > p.start + 0.05);
      if (first && Math.abs(first.start - p.start) < 2) p.start = Math.max(first.start - 0.1, 0);
      const last = [...words].reverse().find((w) => w.start < p.end - 0.05);
      if (last && Math.abs(last.end - p.end) < 2) p.end = Math.min(last.end + 0.3, duration);
    }
    if (p.end - p.start > opts.maxLen) p.end = p.start + opts.maxLen;
    const minLen = Math.min(opts.minLen, duration);
    if (p.end - p.start < minLen) {
      p.end = Math.min(p.start + opts.minLen, duration);
      if (p.end - p.start < minLen) p.start = Math.max(p.end - opts.minLen, 0);
    }
    if (out.some((o) => overlap(o, p) > 0.3)) continue;
    out.push(p);
    if (out.length >= opts.count) break;
  }
  return out;
}
