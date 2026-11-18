// Narration voice for storyboards.
import { writeFile } from "node:fs/promises";

export interface Tts {
  readonly name: string;
  readonly available: boolean;
  /** Writes an MP3 to `file`. */
  speak(text: string, file: string): Promise<void>;
}

export const noTts: Tts = {
  name: "none",
  available: false,
  speak: () => Promise.reject(new Error("no voice provider configured")),
};

export interface OpenAiTtsOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
}

export function openAiTts(opts: OpenAiTtsOptions, fetchFn: typeof fetch = fetch): Tts {
  return {
    name: "openai",
    available: true,
    async speak(text, file) {
      const res = await fetchFn(`${opts.baseUrl.replace(/\/+$/, "")}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, voice: opts.voice, input: text, response_format: "mp3" }),
      });
      if (!res.ok) throw new Error(`speech API returned ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
    },
  };
}
