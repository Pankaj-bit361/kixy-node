import type { ImageGen } from "../ai/images.js";
import type { Llm } from "../ai/llm.js";
import type { Tts } from "../ai/tts.js";

/** The pluggable providers the pipelines use, chosen from config at start-up (or faked in tests). */
export interface Services {
  llm: Llm;
  images: ImageGen;
  tts: Tts;
  captionFont: string;
}

export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return Math.min(hi, Math.max(lo, Math.round(num(v, fallback))));
}
