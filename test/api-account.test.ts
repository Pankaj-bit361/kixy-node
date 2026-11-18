import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { freshDatabase, services, skipWithoutDb, startServer, type TestDb, type TestServer } from "./helpers.js";

describe("accounts and credits", { skip: skipWithoutDb }, () => {
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

  test("health and public config", async () => {
    assert.deepEqual((await s.call("GET", "/api/health")).json, { ok: true });
    const cfg = (await s.call("GET", "/api/config")).json;
    assert.deepEqual(cfg.providers, { llm: "none", images: "placeholder", voice: "none" });
    assert.deepEqual(cfg.caption_styles, ["bold", "clean", "karaoke", "none"]);
    assert.deepEqual(cfg.transcript_formats, ["words", "srt", "vtt"]);
    assert.equal(cfg.pricing.clip_per_minute, 1);
    assert.equal(cfg.signup_credits, 60);
    assert.ok(cfg.styles.length >= 10);
  });

  test("register, then sign in with the same password", async () => {
    const reg = await s.call("POST", "/api/auth/register", { body: { email: " Sam@Example.com ", password: "long enough" } });
    assert.equal(reg.status, 200);
    assert.equal(reg.json.user.email, "sam@example.com");
    assert.equal(reg.json.user.credits, 60);
    const login = await s.call("POST", "/api/auth/login", { body: { email: "sam@example.com", password: "long enough" } });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.id, reg.json.user.id);
    const me = await s.call("GET", "/api/me", { token: login.json.token });
    assert.equal(me.json.credits, 60);
  });

  test("sign-up and sign-in errors", async () => {
    await s.signup("taken@example.com");
    const dup = await s.call("POST", "/api/auth/register", { body: { email: "TAKEN@example.com", password: "long enough" } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, "conflict");
    assert.equal((await s.call("POST", "/api/auth/register", { body: { email: "nope", password: "long enough" } })).status, 400);
    assert.equal((await s.call("POST", "/api/auth/register", { body: { email: "a@b.co", password: "short" } })).status, 400);
    const wrong = await s.call("POST", "/api/auth/login", { body: { email: "taken@example.com", password: "not it at all" } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.message, "wrong email or password");
    assert.equal((await s.call("POST", "/api/auth/login", { body: { email: "ghost@example.com", password: "whatever1" } })).status, 400);
  });

  test("signed-in routes need a valid token", async () => {
    const none = await s.call("GET", "/api/me");
    assert.equal(none.status, 401);
    assert.deepEqual(none.json, { error: "unauthorized", message: "sign in first" });
    assert.equal((await s.call("GET", "/api/me", { token: "a.b.c" })).status, 401);
    assert.equal((await s.call("GET", "/api/jobs", { token: "x" })).status, 401);
  });

  test("the ledger records the welcome credits and demo top-ups", async () => {
    const { token } = await s.signup();
    const top = await s.call("POST", "/api/credits/demo-topup", { token });
    assert.deepEqual(top.json, { credits: 110 });
    const ledger = (await s.call("GET", "/api/credits/ledger", { token })).json;
    assert.deepEqual(
      ledger.map((r: { delta: number; reason: string }) => [r.delta, r.reason]),
      [
        [50, "demo top-up"],
        [60, "welcome credits"],
      ],
    );
  });

  test("bad bodies and unknown routes", async () => {
    const bad = await s.call("POST", "/api/auth/login", { body: "{not json" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.message, "the request body is not valid JSON");
    const missing = await s.call("GET", "/api/nothing-here");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "not_found");
  });

  test("demo top-ups can be turned off", async () => {
    const strict = await startServer(tdb.db, services(), { env: { ALLOW_DEMO_TOPUP: "false", SIGNUP_CREDITS: "5" } });
    try {
      const { token } = await strict.signup("strict@example.com");
      assert.equal((await strict.call("GET", "/api/me", { token })).json.credits, 5);
      assert.equal((await strict.call("POST", "/api/credits/demo-topup", { token })).status, 400);
    } finally {
      await strict.close();
    }
  });
});
