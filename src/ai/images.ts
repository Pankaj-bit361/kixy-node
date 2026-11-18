// Image generation: an OpenAI-compatible images API, or placeholder art (SVG) so every
// feature works with no keys at all.
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const ASPECTS = ["portrait", "square", "landscape"] as const;
export type Aspect = (typeof ASPECTS)[number];

export function parseAspect(s: unknown): Aspect {
  return (ASPECTS as readonly unknown[]).includes(s) ? (s as Aspect) : "portrait";
}

export function aspectSize(a: Aspect): { width: number; height: number } {
  switch (a) {
    case "square":
      return { width: 1024, height: 1024 };
    case "landscape":
      return { width: 1536, height: 1024 };
    case "portrait":
      return { width: 1024, height: 1536 };
  }
}

export interface ImageGen {
  readonly name: string;
  /** Placeholder art carries no picture of the prompt, so callers can draw their own instead. */
  readonly placeholder: boolean;
  /** Writes `n` images into `dir` as `{stem}_{i}.{ext}` and returns their file names. */
  generate(prompt: string, n: number, aspect: Aspect, dir: string, stem: string): Promise<string[]>;
}

export interface OpenAiImagesOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function openAiImages(opts: OpenAiImagesOptions, fetchFn: typeof fetch = fetch): ImageGen {
  return {
    name: "openai",
    placeholder: false,
    async generate(prompt, n, aspect, dir, stem) {
      const { width, height } = aspectSize(aspect);
      const res = await fetchFn(`${opts.baseUrl.replace(/\/+$/, "")}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, prompt, n, size: `${width}x${height}` }),
      });
      const body = (await res.json().catch(() => null)) as {
        data?: { b64_json?: string; url?: string }[];
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new Error(`images API returned ${res.status}: ${body?.error?.message ?? ""}`);
      const names: string[] = [];
      for (const [i, item] of (body?.data ?? []).entries()) {
        let bytes: Buffer;
        if (item.b64_json) {
          bytes = Buffer.from(item.b64_json, "base64");
        } else if (item.url) {
          const img = await fetchFn(item.url);
          if (!img.ok) throw new Error(`could not download a generated image (${img.status})`);
          bytes = Buffer.from(await img.arrayBuffer());
        } else {
          continue;
        }
        const name = `${stem}_${i}.png`;
        await writeFile(path.join(dir, name), bytes);
        names.push(name);
      }
      if (names.length === 0) throw new Error("images API returned no images");
      return names;
    },
  };
}

const PALETTES: readonly [string, string][] = [
  ["#312e81", "#db2777"],
  ["#0f766e", "#84cc16"],
  ["#7c2d12", "#f59e0b"],
  ["#1e3a8a", "#06b6d4"],
  ["#581c87", "#f472b6"],
];

/** Greedy word wrap to `width` characters, at most 8 lines. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [""];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const cur = lines[lines.length - 1];
    if (cur && cur.length + w.length + 1 > width) lines.push(w);
    else lines[lines.length - 1] = cur ? `${cur} ${w}` : w;
  }
  return lines.slice(0, 8);
}

export function seed(text: string): number {
  let a = 7;
  for (const b of Buffer.from(text)) a = (Math.imul(a, 31) + b) >>> 0;
  return a;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}

/** A gradient card with the prompt written on it. */
export function placeholderSvg(prompt: string, variant: number, aspect: Aspect, font: string): string {
  const { width, height } = aspectSize(aspect);
  const [w, h] = [width / 2, height / 2];
  const [c0, c1] = PALETTES[(seed(prompt) + variant) % PALETTES.length];
  const size = Math.max(Math.floor(w / 18), 18);
  const lines = wrap(prompt, 22);
  const lineH = size + 10;
  const top = h / 2 - ((lines.length - 1) * lineH) / 2;
  const boxW = Math.min(w - 40, Math.max(...lines.map((l) => l.length)) * size * 0.6 + 48);
  const boxH = lines.length * lineH + 48;
  const text = lines
    .map((l, i) => `<text x="${w / 2}" y="${(top + i * lineH).toFixed(1)}">${escapeXml(l)}</text>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<rect x="${((w - boxW) / 2).toFixed(1)}" y="${((h - boxH) / 2).toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH}" rx="12" fill="#000" fill-opacity="0.25"/>` +
    `<g fill="#fff" font-family="${escapeXml(font)}, sans-serif" font-size="${size}" text-anchor="middle" dominant-baseline="middle">${text}</g>` +
    `</svg>\n`
  );
}

export function placeholderImages(font: string): ImageGen {
  return {
    name: "placeholder",
    placeholder: true,
    async generate(prompt, n, aspect, dir, stem) {
      const names: string[] = [];
      for (let i = 0; i < n; i++) {
        const name = `${stem}_${i}.svg`;
        await writeFile(path.join(dir, name), placeholderSvg(prompt, i, aspect, font));
        names.push(name);
      }
      return names;
    },
  };
}
