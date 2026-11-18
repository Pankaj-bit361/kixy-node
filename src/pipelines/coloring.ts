// Theme -> printable coloring book: line-art pages (PNG), a PDF and a ZIP of both.
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobHandler } from "../jobs.js";
import { placeholderLineart, toLineart } from "../media/lineart.js";
import { buildPdf } from "../media/pdf.js";
import { decodePngToGray, encodeGrayPng, type GrayImage } from "../media/png.js";
import { buildZip } from "../media/zip.js";
import { clampInt, str, type Services } from "./services.js";

const VARIANTS = [
  "{t} in a sunny meadow", "{t} at the beach", "{t} having a picnic", "{t} in a cozy house", "{t} in outer space",
  "{t} under the sea", "{t} in a magical forest", "{t} at a birthday party", "{t} in the snow", "{t} in a busy city",
  "{t} on a farm", "{t} in a castle", "{t} playing music", "{t} on a camping trip", "{t} in a garden full of flowers",
];

export function fallbackSubjects(theme: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => VARIANTS[i % VARIANTS.length].replace("{t}", theme));
}

const PAGES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: { pages: { type: "array", items: { type: "string" } } },
};

async function planSubjects(services: Services, theme: string, n: number, audience: string): Promise<string[]> {
  if (services.llm.available) {
    const user = `List ${n} different coloring page scenes for a coloring book for ${audience} about "${theme}". One short concrete scene per item.`;
    try {
      const v = (await services.llm.json("You plan coloring books.", user, PAGES_SCHEMA)) as { pages?: unknown };
      const got = Array.isArray(v?.pages) ? v.pages.filter((x): x is string => typeof x === "string").slice(0, n) : [];
      if (got.length === n) return got;
    } catch {
      // The built-in scene list below is a complete answer on its own.
    }
  }
  return fallbackSubjects(theme, n);
}

export function coloringHandler(services: Services): JobHandler {
  return async (ctx) => {
    const input = ctx.job.input;
    const theme = str(input.theme).trim();
    if (!theme) throw new Error("give the book a theme");
    const n = clampInt(input.pages, 1, 30, 8);
    const audience = input.audience === "adults" ? "adults" : "kids";
    const title = str(input.title).trim() || `${theme} Coloring Book`;

    await ctx.progress("planning pages", 0.05);
    const subjects = await planSubjects(services, theme, n, audience);
    const detail = audience === "adults" ? "intricate detailed patterns" : "simple large shapes for young kids";
    const pages: string[] = [];
    const images: GrayImage[] = [];
    for (const [i, subject] of subjects.entries()) {
      await ctx.progress(`drawing page ${i + 1}/${n}`, 0.1 + (0.75 * i) / n);
      let art: GrayImage;
      if (services.images.placeholder) {
        art = placeholderLineart(i);
      } else {
        const prompt = `Coloring book page: ${subject}. Black outlines on a pure white background, thick clean lines, ${detail}, no shading, no gray, no color, no text.`;
        const [raw] = await services.images.generate(prompt, 1, "portrait", ctx.dir, `raw_${String(i + 1).padStart(2, "0")}`);
        art = toLineart(decodePngToGray(await readFile(path.join(ctx.dir, raw))));
        await rm(path.join(ctx.dir, raw), { force: true });
      }
      const name = `page_${String(i + 1).padStart(2, "0")}.png`;
      await writeFile(path.join(ctx.dir, name), encodeGrayPng(art));
      await ctx.addAsset("page", name, { subject });
      pages.push(name);
      images.push(art);
    }

    await ctx.progress("making the PDF", 0.9);
    const pdf = buildPdf(images, title);
    await writeFile(path.join(ctx.dir, "book.pdf"), pdf);
    const readme = `${title}\n${n} pages, 8.5 x 11 in at 150 dpi.\nPages:\n${subjects.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`;
    const zip = buildZip([
      ...(await Promise.all(pages.map(async (p) => ({ name: p, data: await readFile(path.join(ctx.dir, p)) })))),
      { name: "book.pdf", data: pdf },
      { name: "README.txt", data: Buffer.from(readme) },
    ]);
    await writeFile(path.join(ctx.dir, "book.zip"), zip);
    await ctx.addAsset("pdf", "book.pdf", { title });
    await ctx.addAsset("zip", "book.zip", { title });
    return { title, pages, pdf: "book.pdf", zip: "book.zip", subjects };
  };
}
