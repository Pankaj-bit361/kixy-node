import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { decodePngToGray } from "../src/media/png.js";
import { fakeLlm, fakePngImages, fakeTts, freshDatabase, services, skipWithoutDb, startServer, type TestDb, type TestServer } from "./helpers.js";

/** Names of the files in a ZIP, from its central directory. */
function zipNames(buf: Buffer): string[] {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const len = buf.readUInt16LE(p + 28);
    names.push(buf.subarray(p + 46, p + 46 + len).toString("utf8"));
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

async function bytes(s: TestServer, url: string, token: string, headers: Record<string, string> = {}) {
  const res = await fetch(s.base + url, { headers: { authorization: `Bearer ${token}`, ...headers } });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

describe("images, coloring books and storyboards", { skip: skipWithoutDb }, () => {
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

  test("images: one credit each, placeholder art without an image model", async () => {
    const { token } = await s.signup();
    const res = await s.call("POST", "/api/images", { token, body: { prompt: "a red fox in snow", count: 2, style: "watercolor", aspect: "square" } });
    const job = (await s.settled(res.json.job_id, token)).json;
    assert.equal(job.status, "done", job.error);
    assert.deepEqual(job.output, { files: ["image_0.svg", "image_1.svg"], provider: "placeholder" });
    assert.equal(job.cost, 2);
    assert.deepEqual(
      job.assets.map((a: { kind: string; file: string }) => [a.kind, a.file]),
      [
        ["image", "image_0.svg"],
        ["image", "image_1.svg"],
      ],
    );
    const svg = await s.call("GET", `/api/jobs/${job.id}/files/image_0.svg`, { token });
    assert.match(svg.text, /a red fox in snow/);
    assert.match(svg.headers.get("content-type") ?? "", /svg/);
    const list = (await s.call("GET", "/api/jobs?kind=images", { token })).json;
    assert.equal(list.length, 1);
    assert.equal(list[0].thumb, "image_0.svg");
    assert.equal((await s.call("POST", "/api/images", { token, body: { prompt: "  " } })).status, 400);
  });

  test("coloring book: pages, a PDF and a ZIP", async () => {
    const { token } = await s.signup();
    const res = await s.call("POST", "/api/coloring", { token, body: { theme: "ocean animals", pages: 3 } });
    const job = (await s.settled(res.json.job_id, token)).json;
    assert.equal(job.status, "done", job.error);
    assert.deepEqual(job.output.pages, ["page_01.png", "page_02.png", "page_03.png"]);
    assert.equal(job.output.title, "ocean animals Coloring Book");
    assert.equal(job.output.subjects.length, 3);
    assert.equal(job.cost, 3);

    const page = await bytes(s, `/api/jobs/${job.id}/files/page_01.png`, token);
    const img = decodePngToGray(page.body);
    assert.deepEqual([img.width, img.height], [1275, 1650]);

    const pdf = await bytes(s, `/api/jobs/${job.id}/files/book.pdf?download=1`, token);
    assert.equal(pdf.body.subarray(0, 8).toString("latin1"), "%PDF-1.4");
    assert.match(pdf.headers.get("content-disposition") ?? "", /attachment; filename="book.pdf"/);
    assert.match(pdf.body.toString("latin1"), /\/Count 3/);

    const zip = await bytes(s, `/api/jobs/${job.id}/files/book.zip`, token);
    assert.deepEqual(zipNames(zip.body), ["page_01.png", "page_02.png", "page_03.png", "book.pdf", "README.txt"]);
    assert.ok(inflateRawSync(zip.body.subarray(30 + "page_01.png".length)).length > 0);
    assert.deepEqual(
      job.assets.map((a: { kind: string }) => a.kind),
      ["page", "page", "page", "pdf", "zip"],
    );
  });

  test("coloring book from an image model: its pictures are turned into line art", async () => {
    const llm = fakeLlm(() => ({ pages: ["a whale", "a crab"] }));
    const real = await startServer(tdb.db, services({ llm, images: fakePngImages() }));
    try {
      const { token } = await real.signup("png@example.com");
      const res = await real.call("POST", "/api/coloring", { token, body: { theme: "sea", pages: 2, audience: "adults", title: "Deep Blue" } });
      const job = (await real.settled(res.json.job_id, token)).json;
      assert.equal(job.status, "done", job.error);
      assert.deepEqual(job.output.subjects, ["a whale", "a crab"]);
      const page = decodePngToGray((await bytes(real, `/api/jobs/${job.id}/files/page_02.png`, token)).body);
      assert.ok(page.pixels.some((v) => v === 0), "the drawn outline is there");
      assert.ok(page.pixels.every((v) => v === 0 || v === 255));
      assert.equal(existsSync(`${real.queue.jobDir(job.id)}/raw_01_0.png`), false, "the raw picture is cleaned up");
    } finally {
      await real.close();
    }
  });

  test("storyboard: a script, a picture per scene and narration audio", async () => {
    const llm = fakeLlm(() => ({
      title: "Tiny chef",
      scenes: [
        { narration: "Meet the smallest chef in the city.", visual: "a tiny chef on a counter" },
        { narration: "Today she cooks one perfect pea.", visual: "a pea in a pan" },
        { narration: "This line is beyond the scene count.", visual: "extra" },
      ],
    }));
    const tts = fakeTts();
    const studio = await startServer(tdb.db, services({ llm, tts }));
    try {
      const { token } = await studio.signup("story@example.com");
      const res = await studio.call("POST", "/api/storyboard", { token, body: { prompt: "a tiny chef", duration: 10, style: "claymation" } });
      const job = (await studio.settled(res.json.job_id, token)).json;
      assert.equal(job.status, "done", job.error);
      assert.equal(job.cost, 5);
      assert.equal(job.output.title, "Tiny chef");
      assert.equal(job.output.scenes.length, 2);
      assert.deepEqual(
        job.output.scenes.map((sc: { image: string; audio: string }) => [sc.image, sc.audio]),
        [
          ["scene_1_0.svg", "scene_1.mp3"],
          ["scene_2_0.svg", "scene_2.mp3"],
        ],
      );
      assert.equal(job.output.voice, true);
      assert.deepEqual(tts.spoken, ["Meet the smallest chef in the city.", "Today she cooks one perfect pea."]);
      const audio = await bytes(studio, `/api/jobs/${job.id}/files/scene_1.mp3`, token);
      assert.equal(audio.status, 200);
    } finally {
      await studio.close();
    }
  });

  test("storyboard without a model or voice still works and says what is missing", async () => {
    const { token } = await s.signup();
    const res = await s.call("POST", "/api/storyboard", { token, body: { prompt: "a cat learns to surf", duration: 15 } });
    const job = (await s.settled(res.json.job_id, token)).json;
    assert.equal(job.status, "done", job.error);
    assert.equal(job.output.scenes.length, 3);
    assert.equal(job.output.voice, false);
    assert.match(job.output.notes.join(" "), /No voice provider/);
    assert.equal(job.output.scenes[0].audio, null);
    assert.equal((await s.call("POST", "/api/storyboard", { token, body: {} })).status, 400);
  });

  test("files: ranges, tokens in the link, and nothing outside the job folder", async () => {
    const { token } = await s.signup();
    const res = await s.call("POST", "/api/coloring", { token, body: { theme: "space", pages: 1 } });
    const job = (await s.settled(res.json.job_id, token)).json;
    const url = `/api/jobs/${job.id}/files/book.pdf`;

    const part = await bytes(s, url, token, { range: "bytes=0-7" });
    assert.equal(part.status, 206);
    assert.equal(part.body.toString("latin1"), "%PDF-1.4");
    assert.match(part.headers.get("content-range") ?? "", /^bytes 0-7\/\d+$/);

    const viaQuery = await fetch(`${s.base}${url}?token=${encodeURIComponent(token)}`);
    assert.equal(viaQuery.status, 200);

    for (const name of ["..%2F..%2Fpackage.json", ".hidden", "missing.png", "..%5Csecret"]) {
      assert.equal((await bytes(s, `/api/jobs/${job.id}/files/${name}`, token)).status, 404, name);
    }
    assert.equal((await bytes(s, `/api/jobs/${job.id}/../../package.json`, token)).status, 404);
  });

  test("deleting a job removes its rows and files but keeps the ledger", async () => {
    const { token } = await s.signup();
    const res = await s.call("POST", "/api/images", { token, body: { prompt: "a lighthouse" } });
    const job = (await s.settled(res.json.job_id, token)).json;
    const dir = s.queue.jobDir(job.id);
    assert.equal(existsSync(dir), true);
    const del = await s.call("DELETE", `/api/jobs/${job.id}`, { token });
    assert.deepEqual(del.json, { deleted: job.id });
    assert.equal(existsSync(dir), false);
    assert.equal((await s.call("GET", `/api/jobs/${job.id}`, { token })).status, 404);
    const ledger = (await s.call("GET", "/api/credits/ledger", { token })).json;
    assert.deepEqual(
      ledger.map((r: { delta: number; job_id: string | null }) => [r.delta, r.job_id]),
      [
        [-1, null],
        [60, null],
      ],
    );
    const assets = await tdb.db.query("SELECT count(*)::int AS n FROM assets WHERE job_id = $1", [job.id]);
    assert.equal(assets.rows[0].n, 0);
  });
});
