import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { clipCost } from "../src/credits.js";
import { fakeLlm, freshDatabase, services, skipWithoutDb, startServer, talkSrt, talkWords, type TestDb, type TestServer } from "./helpers.js";

interface ClipJson {
  id: string;
  idx: number;
  title: string;
  hook: string;
  start: number;
  end: number;
  words: { start: number; end: number; text: string }[];
  captions: string;
  version: number;
  caption_style: string;
  render: { source: string; start: number; end: number; output: { width: number; height: number }; framing: unknown; captions: string };
}

describe("clip finder", { skip: skipWithoutDb }, () => {
  let tdb: TestDb;
  let s: TestServer;
  before(async () => {
    tdb = await freshDatabase();
    s = await startServer(tdb.db, services());
  });
  after(async () => {
    await s?.close();
    await tdb?.drop();
  });

  test("an SRT transcript becomes scored clips with captions and render plans", async () => {
    const { token } = await s.signup();
    const srt = talkSrt();
    const res = await s.call("POST", "/api/clipper", {
      token,
      body: {
        name: "talk.mp4",
        transcript: srt,
        source: { width: 1920, height: 1080 },
        options: { count: 3, min_len: 15, max_len: 40, caption_style: "karaoke" },
      },
    });
    assert.equal(res.status, 200, res.text);
    const job = (await s.settled(res.json.job_id, token)).json;
    assert.equal(job.status, "done", job.error);
    assert.equal(job.kind, "clip");
    assert.equal(job.output.picker, "heuristic");
    assert.equal(job.output.clips, job.clips.length);
    assert.ok(job.clips.length >= 2 && job.clips.length <= 3);

    const duration = job.output.duration;
    assert.equal(job.cost, clipCost(duration));
    assert.equal((await s.call("GET", "/api/me", { token })).json.credits, 60 - clipCost(duration));

    for (const c of job.clips as ClipJson[]) {
      assert.equal(c.caption_style, "karaoke");
      assert.equal(c.version, 1);
      assert.equal(c.captions, `clip_${c.idx}_v1.ass`);
      assert.ok(c.words.length > 10);
      assert.ok(c.words.every((w) => w.end > c.start && w.start < c.end));
      assert.deepEqual(c.render.framing, { kind: "crop", x: 657, y: 0, width: 606, height: 1080 });
      assert.equal(c.render.source, "talk.mp4");
      assert.deepEqual([c.render.start, c.render.end], [c.start, c.end]);
      assert.equal(c.render.output.width, 720);
      const ass = await s.call("GET", `/api/jobs/${job.id}/files/${c.captions}`, { token });
      assert.equal(ass.status, 200);
      assert.match(ass.text, /Style: Karaoke/);
      assert.match(ass.text, /\{\\kf\d+\}/);
    }

    const transcript = (await s.call("GET", `/api/jobs/${job.id}/transcript`, { token })).json;
    assert.equal(transcript.length, talkWords().length);
  });

  test("with a language model, its picks are used and snapped to the words", async () => {
    const llm = fakeLlm(() => ({
      clips: [
        { start: 1, end: 25, title: "The money mistake", hook: "Stop waiting", score: 91, reason: "Bold claim" },
        { start: 60.2, end: 85, title: "The rule", hook: "Never skip", score: 70, reason: "Clear payoff" },
      ],
    }));
    const ai = await startServer(tdb.db, services({ llm }));
    try {
      const { token } = await ai.signup("ai@example.com");
      const res = await ai.call("POST", "/api/clipper", { token, body: { transcript: talkWords(), options: { min_len: 15, max_len: 40 } } });
      const job = (await ai.settled(res.json.job_id, token)).json;
      assert.equal(job.status, "done", job.error);
      assert.equal(job.output.picker, "fake");
      assert.deepEqual(
        job.clips.map((c: ClipJson) => c.title),
        ["The money mistake", "The rule"],
      );
      assert.equal(job.clips[0].hook, "Stop waiting");
      assert.equal(job.clips[0].render.framing, null, "no source size given");
      assert.equal(llm.calls, 1);
    } finally {
      await ai.close();
    }
  });

  test("when the model fails, the built-in picker takes over and says so", async () => {
    const llm = fakeLlm(() => new Error("rate limited"));
    const ai = await startServer(tdb.db, services({ llm }));
    try {
      const { token } = await ai.signup("flaky@example.com");
      const res = await ai.call("POST", "/api/clipper", { token, body: { transcript: talkWords() } });
      const job = (await ai.settled(res.json.job_id, token)).json;
      assert.equal(job.status, "done");
      assert.equal(job.output.picker, "heuristic");
      assert.match(job.output.notes[0], /rate limited/);
    } finally {
      await ai.close();
    }
  });

  test("loudness alone finds moments, without captions", async () => {
    const { token } = await s.signup();
    const loudness = Array.from({ length: 180 }, (_, i) => (i >= 100 && i < 130 ? 0.8 : 0.1));
    const res = await s.call("POST", "/api/clipper", { token, body: { loudness, options: { count: 2, min_len: 20, max_len: 30 } } });
    const job = (await s.settled(res.json.job_id, token)).json;
    assert.equal(job.status, "done", job.error);
    assert.match(job.output.notes[0], /No transcript/);
    assert.ok(job.clips[0].start >= 90 && job.clips[0].start <= 115, `start ${job.clips[0].start}`);
    assert.deepEqual(job.clips[0].words, []);
    assert.equal(job.cost, 3);
  });

  test("clipper requests are checked before anything is charged", async () => {
    const { token } = await s.signup();
    const cases: [unknown, RegExp][] = [
      [{}, /add a transcript/],
      [{ loudness: [1, -2] }, /loudness must be/],
      [{ transcript: [{ start: 1, end: 0, text: "x" }] }, /end before its start/],
      [{ transcript: talkWords(), source: { width: 10, height: 1080 } }, /whole pixels/],
      [{ transcript: talkWords(), duration: -5 }, /between 0 and 12 hours/],
      [{ transcript: "1\n00:00:00,100 --> 00:00:00,600\nhi\n", format: "srt" }, /at least a second/],
    ];
    for (const [body, message] of cases) {
      const r = await s.call("POST", "/api/clipper", { token, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.message, message);
    }
    assert.equal((await s.call("GET", "/api/me", { token })).json.credits, 60);
    assert.deepEqual((await s.call("GET", "/api/jobs", { token })).json, []);
  });

  test("not enough credits: 402 with what is needed, and no job", async () => {
    const poor = await startServer(tdb.db, services(), { env: { SIGNUP_CREDITS: "1" } });
    try {
      const { token } = await poor.signup("poor@example.com");
      const r = await poor.call("POST", "/api/clipper", { token, body: { transcript: talkWords(), duration: 600 } });
      assert.equal(r.status, 402);
      assert.deepEqual([r.json.error, r.json.need, r.json.have], ["no_credits", 10, 1]);
      assert.deepEqual((await poor.call("GET", "/api/jobs", { token })).json, []);
      const ledger = (await poor.call("GET", "/api/credits/ledger", { token })).json;
      assert.equal(ledger.length, 1);
    } finally {
      await poor.close();
    }
  });

  describe("editing a clip", () => {
    let token: string;
    let jobId: string;
    let clip: ClipJson;
    before(async () => {
      ({ token } = await s.signup());
      const res = await s.call("POST", "/api/clipper", {
        token,
        body: { transcript: talkWords(), source: { width: 1920, height: 1080 }, options: { count: 2, min_len: 15, max_len: 40 } },
      });
      jobId = res.json.job_id;
      const job = (await s.settled(jobId, token)).json;
      clip = job.clips[0];
    });

    test("a title change keeps the captions", async () => {
      const r = await s.call("PATCH", `/api/clips/${clip.id}`, { token, body: { title: "New title", crop_x: 0 } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.clip.title, "New title");
      assert.equal(r.json.clip.version, 1);
      assert.deepEqual(r.json.clip.render.framing, { kind: "crop", x: 0, y: 0, width: 606, height: 1080 });
    });

    test("a trim re-reads the transcript and writes a new caption file", async () => {
      const start = clip.start + 2;
      const r = await s.call("PATCH", `/api/clips/${clip.id}`, { token, body: { start, caption_style: "clean" } });
      assert.equal(r.status, 200, r.text);
      const c: ClipJson = r.json.clip;
      assert.equal(c.version, 2);
      assert.equal(c.captions, `clip_${c.idx}_v2.ass`);
      assert.equal(c.start, start);
      assert.ok(c.words.every((w) => w.end > start));
      const fresh = await s.call("GET", `/api/jobs/${jobId}/files/${c.captions}`, { token });
      assert.match(fresh.text, /,Clean,/);
      assert.equal((await s.call("GET", `/api/jobs/${jobId}/files/${clip.captions}`, { token })).status, 404, "the old file is gone");
      const files = await readFile(path.join(s.queue.jobDir(jobId), c.captions), "utf8");
      assert.equal(files, fresh.text);
    });

    test("edited words show up in the captions", async () => {
      const current: ClipJson = (await s.call("GET", `/api/clips/${clip.id}`, { token })).json;
      const words = current.words.map((w, i) => (i === 0 ? { ...w, text: "Edited" } : w));
      const r = await s.call("PATCH", `/api/clips/${clip.id}`, { token, body: { words } });
      assert.equal(r.json.clip.version, current.version + 1);
      const ass = await s.call("GET", `/api/jobs/${jobId}/files/${r.json.clip.captions}`, { token });
      assert.match(ass.text, /Edited/);
    });

    test("bad edits are refused", async () => {
      const tooShort = await s.call("PATCH", `/api/clips/${clip.id}`, { token, body: { start: 10, end: 10.5 } });
      assert.equal(tooShort.status, 400);
      assert.match(tooShort.json.message, /between 1 second and 3 minutes/);
      assert.equal((await s.call("PATCH", `/api/clips/${clip.id}`, { token, body: { start: "soon" } })).status, 400);
      assert.equal((await s.call("PATCH", `/api/clips/${clip.id}`, { token, body: { words: [{ start: 1 }] } })).status, 400);
      assert.equal((await s.call("PATCH", `/api/clips/not-a-uuid`, { token, body: {} })).status, 404);
    });

    test("other people's clips and jobs are not visible", async () => {
      const other = await s.signup();
      assert.equal((await s.call("GET", `/api/clips/${clip.id}`, { token: other.token })).status, 404);
      assert.equal((await s.call("PATCH", `/api/clips/${clip.id}`, { token: other.token, body: { title: "mine" } })).status, 404);
      assert.equal((await s.call("GET", `/api/jobs/${jobId}`, { token: other.token })).status, 404);
      assert.equal((await s.call("GET", `/api/jobs/${jobId}/files/${clip.captions}`, { token: other.token })).status, 404);
    });
  });
});
