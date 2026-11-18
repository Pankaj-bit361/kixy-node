// Transcripts come in as timed words (JSON) or as subtitle files (SRT or WebVTT).
import { AppError } from "../errors.js";
import type { Word } from "../types.js";

export type TranscriptFormat = "words" | "srt" | "vtt";

const MAX_WORDS = 200_000;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** `[{start, end, text}]`, as written by most speech-to-text APIs (`word` is accepted for `text`). */
export function parseWords(input: unknown): Word[] {
  if (!Array.isArray(input)) throw AppError.badRequest("transcript words must be an array");
  const out: Word[] = [];
  input.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text : typeof r.word === "string" ? r.word : undefined;
    if (!finite(r.start) || !finite(r.end) || text === undefined) {
      throw AppError.badRequest(`transcript word ${i + 1} needs numeric start and end and a text`);
    }
    if (r.start < 0 || r.end < r.start) {
      throw AppError.badRequest(`transcript word ${i + 1} has its end before its start`);
    }
    const t = text.trim();
    if (t) out.push({ start: r.start, end: r.end, text: t });
  });
  return sortAndLimit(out);
}

/** `00:01:02,500` or `01:02.500` to seconds. */
export function parseTimestamp(s: string): number | undefined {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return undefined;
  const [, h, min, sec, frac] = m;
  const ms = frac ? Number(frac.padEnd(3, "0")) : 0;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec) + ms / 1000;
}

function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spread a cue's time over its words, in proportion to their length. */
export function cueToWords(start: number, end: number, text: string): Word[] {
  const tokens = text.split(" ").filter(Boolean);
  if (tokens.length === 0 || end <= start) return [];
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = end - start;
  let t = start;
  return tokens.map((text, i) => {
    const len = (span * weights[i]) / total;
    const w = { start: round3(t), end: round3(i === tokens.length - 1 ? end : t + len), text };
    t += len;
    return w;
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** SRT and WebVTT share the cue shape: a `start --> end` line, then text lines until a blank line. */
export function parseSubtitles(text: string): Word[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const out: Word[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("-->")) continue;
    const [a, rest] = line.split("-->");
    const start = parseTimestamp(a);
    const end = parseTimestamp(rest.trim().split(/\s+/)[0] ?? "");
    if (start === undefined || end === undefined) {
      throw AppError.badRequest(`could not read the cue times on line ${i + 1}`);
    }
    const body: string[] = [];
    while (i + 1 < lines.length && lines[i + 1].trim() !== "") body.push(lines[++i]);
    out.push(...cueToWords(start, end, cleanCueText(body.join(" "))));
  }
  return sortAndLimit(out);
}

function sortAndLimit(words: Word[]): Word[] {
  if (words.length > MAX_WORDS) throw AppError.badRequest(`a transcript can have at most ${MAX_WORDS} words`);
  return words.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function detectFormat(input: unknown): TranscriptFormat {
  if (Array.isArray(input)) return "words";
  if (typeof input === "string") return /^﻿?WEBVTT/.test(input.trimStart()) ? "vtt" : "srt";
  throw AppError.badRequest("send the transcript as timed words or as SRT or WebVTT text");
}

export function parseTranscript(input: unknown, format?: string): Word[] {
  const f = format ?? detectFormat(input);
  switch (f) {
    case "words":
      return parseWords(input);
    case "srt":
    case "vtt":
      if (typeof input !== "string") throw AppError.badRequest(`a ${f} transcript must be text`);
      return parseSubtitles(input);
    default:
      throw AppError.badRequest("transcript format must be words, srt or vtt");
  }
}
