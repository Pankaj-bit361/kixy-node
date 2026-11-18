// Text idea -> storyboard for a short vertical video: a script split into scenes, an image per
// scene in the chosen style, and narration audio per scene when a voice is configured.
import { stylePrompt } from "../ai/styles.js";
import { errorMessage } from "../errors.js";
import type { JobHandler } from "../jobs.js";
import { num, str, type Services } from "./services.js";
import path from "node:path";

export interface Scene {
  narration: string;
  visual: string;
}

const SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "scenes"],
  properties: {
    title: { type: "string" },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["narration", "visual"],
        properties: {
          narration: { type: "string", description: "what is said or shown as caption, about 12 words" },
          visual: { type: "string", description: "a concrete description of the image for this scene" },
        },
      },
    },
  },
};

/** No model: split the idea into sentences and reuse them as narration. */
export function fallbackScript(prompt: string, n: number): { title: string; scenes: Scene[] } {
  const parts = prompt.split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) parts.push("Untitled");
  const title = Array.from(parts[0]).slice(0, 60).join("");
  const scenes = Array.from({ length: n }, (_, i) => {
    const line = parts[i % parts.length];
    return { narration: line, visual: `${line}, scene ${i + 1} of ${n}` };
  });
  return { title, scenes };
}

export function sceneCount(targetSeconds: number): number {
  return Math.min(6, Math.max(1, Math.ceil(targetSeconds / 5)));
}

async function writeScript(services: Services, prompt: string, target: number, n: number, notes: string[]) {
  if (!services.llm.available) return fallbackScript(prompt, n);
  const user =
    `Write a short vertical video of about ${target.toFixed(0)} seconds from this idea: "${prompt}".\n` +
    `Make exactly ${n} scenes. Each narration line is spoken in about ${(target / n).toFixed(0)} seconds (10-14 words). ` +
    "The first line must hook the viewer. Each visual describes one clear image, with no text in it.";
  try {
    const v = (await services.llm.json("You write scripts for short, engaging vertical videos.", user, SCRIPT_SCHEMA)) as {
      title?: unknown;
      scenes?: { narration?: unknown; visual?: unknown }[];
    };
    const scenes = (Array.isArray(v?.scenes) ? v.scenes : [])
      .filter((s) => typeof s?.narration === "string" && typeof s?.visual === "string")
      .slice(0, n)
      .map((s) => ({ narration: s.narration as string, visual: s.visual as string }));
    if (scenes.length > 0) return { title: str(v.title, "Untitled"), scenes };
    return fallbackScript(prompt, n);
  } catch (e) {
    notes.push(`Script model unavailable (${errorMessage(e)}); used your idea as the script.`);
    return fallbackScript(prompt, n);
  }
}

export function storyboardHandler(services: Services): JobHandler {
  return async (ctx) => {
    const input = ctx.job.input;
    const prompt = str(input.prompt).trim();
    if (!prompt) throw new Error("write an idea for the video");
    const style = str(input.style, "cinematic");
    const target = Math.min(30, Math.max(5, num(input.duration, 15)));
    const wantVoice = input.voice !== false;
    const n = sceneCount(target);
    const notes: string[] = [];

    await ctx.progress("writing the script", 0.05);
    const { title, scenes } = await writeScript(services, prompt, target, n, notes);

    const out: { narration: string; visual: string; image: string; audio: string | null }[] = [];
    let voiced = 0;
    for (const [i, sc] of scenes.entries()) {
      await ctx.progress(`drawing scene ${i + 1}/${scenes.length}`, 0.1 + (0.8 * i) / scenes.length);
      const [image] = await services.images.generate(`${sc.visual}. ${stylePrompt(style)}`, 1, "portrait", ctx.dir, `scene_${i + 1}`);
      await ctx.addAsset("image", image, { prompt: sc.visual, scene: i + 1 });
      let audio: string | null = null;
      if (wantVoice && services.tts.available) {
        try {
          audio = `scene_${i + 1}.mp3`;
          await services.tts.speak(sc.narration, path.join(ctx.dir, audio));
          await ctx.addAsset("audio", audio, { scene: i + 1 });
          voiced++;
        } catch (e) {
          audio = null;
          notes.push(`Voice failed for scene ${i + 1} (${errorMessage(e)}).`);
        }
      }
      out.push({ ...sc, image, audio });
    }
    if (wantVoice && !services.tts.available) notes.push("No voice provider is set, so the storyboard has no narration audio.");
    return { title, style, duration: target, scenes: out, voice: voiced > 0, notes };
  };
}
