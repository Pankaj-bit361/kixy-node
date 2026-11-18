import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import type { ImageGen } from "../src/ai/images.js";
import { noLlm, type Llm } from "../src/ai/llm.js";
import { noTts, type Tts } from "../src/ai/tts.js";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/pool.js";
import { jobHandlers } from "../src/handlers.js";
import { JobQueue, type JobHandler } from "../src/jobs.js";
import { encodeGrayPng } from "../src/media/png.js";
import type { Services } from "../src/pipelines/services.js";
import { placeholderImages } from "../src/ai/images.js";
import type { Word } from "../src/types.js";

// ---------- sample data ----------

export const SENTENCES = [
  "Nobody tells you the biggest mistake people make with money.",
  "They wait for the perfect moment to start.",
  "I did that for ten years and it cost me a fortune.",
  "So why do we keep waiting?",
  "Because starting feels risky and waiting feels safe.",
  "But waiting is actually the riskiest thing you can do!",
  "Here is the simple rule I use now.",
  "Put a small amount aside every single week, no matter what.",
  "It sounds boring, and that is exactly why it works.",
  "Let me show you what happened when I tried it.",
  "In the first month nothing changed at all.",
  "In the sixth month I had a real cushion for the first time.",
  "And after two years the habit paid for a whole trip.",
  "The secret is not the amount you save.",
  "The secret is that you never skip a week.",
  "How do you make sure you never skip?",
  "You make the transfer automatic on payday.",
  "Then you forget about it and live your life.",
  "That is the whole system, and it fits on a sticky note.",
  "Try it for one month and tell me how it goes!",
];

/** Timed words for SENTENCES: 0.4 s per word and a 0.8 s pause after each sentence. */
export function talkWords(sentences = SENTENCES, repeat = 3): Word[] {
  const words: Word[] = [];
  let t = 1;
  for (let r = 0; r < repeat; r++) {
    for (const s of sentences) {
      for (const text of s.split(" ")) {
        words.push({ start: round(t), end: round(t + 0.35), text });
        t += 0.4;
      }
      t += 0.8;
    }
  }
  return words;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function srtTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

/** The same talk as an SRT file, one cue per sentence. */
export function talkSrt(sentences = SENTENCES, repeat = 3): string {
  const cues: string[] = [];
  let t = 1;
  let n = 1;
  for (let r = 0; r < repeat; r++) {
    for (const s of sentences) {
      const end = t + s.split(" ").length * 0.4 - 0.05;
      cues.push(`${n++}\n${srtTime(t)} --> ${srtTime(end)}\n${s}\n`);
      t = end + 0.85;
    }
  }
  return cues.join("\n");
}

// ---------- fake providers ----------

export function fakeLlm(answer: (system: string, user: string, schema: Record<string, unknown>) => unknown): Llm & { calls: number } {
  const llm = {
    name: "fake",
    available: true,
    calls: 0,
    async json(system: string, user: string, schema: Record<string, unknown>) {
      llm.calls++;
      const v = answer(system, user, schema);
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return llm;
}

/** An image provider that writes small PNGs, like a real one would. */
export function fakePngImages(): ImageGen {
  return {
    name: "fake-png",
    placeholder: false,
    async generate(_prompt, n, _aspect, dir, stem) {
      const width = 60;
      const height = 80;
      const pixels = new Uint8Array(width * height).fill(255);
      for (let y = 20; y < 60; y++) for (let x = 15; x < 45; x++) if (x === 15 || x === 44 || y === 20 || y === 59) pixels[y * width + x] = 0;
      const names: string[] = [];
      for (let i = 0; i < n; i++) {
        const name = `${stem}_${i}.png`;
        await writeFile(path.join(dir, name), encodeGrayPng({ width, height, pixels }));
        names.push(name);
      }
      return names;
    },
  };
}

export function fakeTts(): Tts & { spoken: string[] } {
  const tts = {
    name: "fake-voice",
    available: true,
    spoken: [] as string[],
    async speak(text: string, file: string) {
      tts.spoken.push(text);
      await writeFile(file, Buffer.from("ID3fake-mp3"));
    },
  };
  return tts;
}

export function services(over: Partial<Services> = {}): Services {
  return { llm: noLlm, images: placeholderImages("Inter"), tts: noTts, captionFont: "Inter", ...over };
}

// ---------- database ----------

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** For `test(name, { skip }, fn)`: skip database tests when no server is available. */
export const skipWithoutDb: string | false = TEST_DATABASE_URL ? false : "no TEST_DATABASE_URL (npm test starts a PostgreSQL for you)";

export interface TestDb {
  db: Db;
  url: string;
  drop(): Promise<void>;
}

/** A new, migrated database on the test server, dropped afterwards. */
export async function freshDatabase(): Promise<TestDb> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const name = `kixy_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${name}`;
  const db = createPool(u.toString());
  await migrate(db);
  return {
    db,
    url: u.toString(),
    async drop() {
      await db.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

// ---------- a running server ----------

export interface Reply {
  status: number;
  headers: Headers;
  json: any;
  text: string;
}

export interface TestServer {
  base: string;
  cfg: Config;
  db: Db;
  queue: JobQueue;
  dataDir: string;
  call(method: string, url: string, opts?: { body?: unknown; token?: string; headers?: Record<string, string> }): Promise<Reply>;
  signup(email?: string): Promise<{ token: string; id: string }>;
  /** Wait for background jobs, then read a job back. */
  settled(jobId: string, token: string): Promise<Reply>;
  close(): Promise<void>;
}

export async function startServer(
  db: Db,
  svc: Services,
  opts: { env?: Record<string, string>; extraHandlers?: Record<string, JobHandler> } = {},
): Promise<TestServer> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "kixy-test-data-"));
  const cfg = loadConfig({ DATA_DIR: dataDir, JWT_SECRET: "test-secret", ...opts.env });
  const queue = new JobQueue(db, dataDir, 2, { ...jobHandlers(db, svc), ...opts.extraHandlers });
  const app = createApp({ cfg, db, queue, services: svc });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, url: string, o: { body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let body: string | undefined;
    if (o.body !== undefined) {
      headers["content-type"] ??= "application/json";
      body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    }
    const res = await fetch(base + url, { method, headers, body });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  let n = 0;
  return {
    base,
    cfg,
    db,
    queue,
    dataDir,
    call,
    async signup(email) {
      const r = await call("POST", "/api/auth/register", { body: { email: email ?? `user${++n}@example.com`, password: "correct horse" } });
      if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${r.text}`);
      return { token: r.json.token as string, id: r.json.user.id as string };
    },
    async settled(jobId, token) {
      await queue.idle();
      return call("GET", `/api/jobs/${jobId}`, { token });
    },
    async close() {
      await queue.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
