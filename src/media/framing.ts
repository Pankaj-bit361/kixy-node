// How a source frame maps onto the 720x1280 (9:16) output: a crop window, or the whole frame fitted.
export const OUTPUT = { width: 720, height: 1280, fps: 30 } as const;

export const CROP_MODES = ["auto", "center", "fit"] as const;
export type CropMode = (typeof CROP_MODES)[number];

export function parseCropMode(s: unknown): CropMode {
  return (CROP_MODES as readonly unknown[]).includes(s) ? (s as CropMode) : "auto";
}

export interface SourceSize {
  width: number;
  height: number;
}

/**
 * `crop`: cut this window out of the source and scale it to fill the output.
 * `fit`: show the whole source, scaled down, over a blurred copy of itself.
 */
export type Framing = { kind: "crop"; x: number; y: number; width: number; height: number } | { kind: "fit" };

/**
 * Wider-than-9:16 sources get a full-height window whose centre sits at `centerX` (0 to 1) of the
 * width, or at the middle in `center` mode. Narrower sources are scaled to cover the frame and
 * cropped at the middle.
 */
export function framing(src: SourceSize, mode: CropMode, centerX: number): Framing {
  if (mode === "fit") return { kind: "fit" };
  const { width: w, height: h } = src;
  const target = OUTPUT.width / OUTPUT.height;
  if (w / h > target) {
    const cw = Math.floor((h * target) / 2) * 2;
    const c = mode === "center" ? 0.5 : clamp(centerX, 0, 1);
    const x = Math.round(clamp(c * w - cw / 2, 0, w - cw));
    return { kind: "crop", x, y: 0, width: cw, height: h };
  }
  const ch = Math.min(h, Math.floor(w / target / 2) * 2);
  return { kind: "crop", x: 0, y: Math.round((h - ch) / 2), width: w, height: ch };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
