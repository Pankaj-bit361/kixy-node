// Prompt -> 1 to 4 images in a style.
import { parseAspect } from "../ai/images.js";
import { stylePrompt } from "../ai/styles.js";
import type { JobHandler } from "../jobs.js";
import { clampInt, str, type Services } from "./services.js";

export function fullImagePrompt(prompt: string, style: string): string {
  return !style || style === "none" ? prompt : `${prompt}. ${stylePrompt(style)}`;
}

export function imagesHandler(services: Services): JobHandler {
  return async (ctx) => {
    const input = ctx.job.input;
    const prompt = str(input.prompt).trim();
    if (!prompt) throw new Error("describe the image");
    const n = clampInt(input.count, 1, 4, 1);
    await ctx.progress("generating", 0.2);
    const files = await services.images.generate(fullImagePrompt(prompt, str(input.style)), n, parseAspect(input.aspect), ctx.dir, "image");
    for (const f of files) await ctx.addAsset("image", f, { prompt });
    return { files, provider: services.images.name };
  };
}
