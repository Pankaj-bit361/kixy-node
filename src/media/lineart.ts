// Coloring pages: clean black-on-white line art at 8.5 x 11 inches, 150 dpi.
import type { GrayImage } from "./png.js";

export const PAGE = { width: 1275, height: 1650 } as const;

/** Scale an image to fit the page (bilinear), centre it on white and cut it to pure black and white. */
export function toLineart(src: GrayImage, threshold = 165): GrayImage {
  const scale = Math.min(PAGE.width / src.width, PAGE.height / src.height);
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const ox = Math.floor((PAGE.width - dw) / 2);
  const oy = Math.floor((PAGE.height - dh) / 2);
  const out = new Uint8Array(PAGE.width * PAGE.height).fill(255);
  const at = (x: number, y: number): number => src.pixels[y * src.width + x];
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;
      const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
      const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
      const v = top * (1 - fy) + bottom * fy;
      out[(oy + y) * PAGE.width + ox + x] = v > threshold ? 255 : 0;
    }
  }
  return { width: PAGE.width, height: PAGE.height, pixels: out };
}

/** Line art drawn locally when no image model is set: a mandala of rings and spokes. */
export function placeholderLineart(variant: number): GrayImage {
  const { width: w, height: h } = PAGE;
  const unit = h / 1100;
  const ring = (40 + (variant % 5) * 12) * unit;
  const line = 3 * unit;
  const spokes = 6 + (variant % 4) * 2;
  const cx = w / 2;
  const cy = h / 2.4;
  const radius = h / 2.6;
  const out = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r >= radius) continue;
      const onRing = r % ring < line;
      const onSpoke = Math.abs(Math.sin(spokes * Math.atan2(dy, dx))) < 0.02;
      if (onRing || onSpoke) out[y * w + x] = 0;
    }
  }
  return { width: w, height: h, pixels: out };
}
