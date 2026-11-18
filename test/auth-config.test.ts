import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, issueToken, readToken, verifyPassword } from "../src/auth.js";
import { DEV_JWT_SECRET, loadConfig } from "../src/config.js";
import { clipCost } from "../src/credits.js";

test("passwords are salted scrypt hashes", async () => {
  const a = await hashPassword("correct horse");
  const b = await hashPassword("correct horse");
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse", a), true);
  assert.equal(await verifyPassword("wrong horse", a), false);
  assert.equal(await verifyPassword("x", "plain-text"), false);
});

test("tokens: signed, expiring, and tied to the secret", () => {
  const now = Date.UTC(2026, 0, 1);
  const t = issueToken("s1", "user-1", "a@example.com", now);
  assert.deepEqual(readToken("s1", t, now + 1000)?.sub, "user-1");
  assert.equal(readToken("s2", t, now), undefined);
  assert.equal(readToken("s1", t, now + 15 * 86400 * 1000), undefined);
  const [h, , s] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "admin", email: "x", iat: 0, exp: 9e9 })).toString("base64url");
  assert.equal(readToken("s1", `${h}.${forged}.${s}`, now), undefined);
  const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  assert.equal(readToken("s1", `${none}.${t.split(".")[1]}.`, now), undefined);
  assert.equal(readToken("s1", "garbage", now), undefined);
});

test("config defaults and provider choice by key", () => {
  const base = loadConfig({});
  assert.equal(base.port, 8080);
  assert.equal(base.jwtSecret, DEV_JWT_SECRET);
  assert.equal(base.llmProvider, "none");
  assert.equal(base.imageProvider, "placeholder");
  assert.equal(base.ttsProvider, "none");
  assert.equal(base.anthropicModel, "claude-sonnet-5-5");

  const withClaude = loadConfig({ ANTHROPIC_API_KEY: "k", PORT: "9000", ALLOW_DEMO_TOPUP: "false" });
  assert.equal(withClaude.llmProvider, "anthropic");
  assert.equal(withClaude.port, 9000);
  assert.equal(withClaude.allowDemoTopup, false);

  const withOpenAi = loadConfig({ OPENAI_API_KEY: "k" });
  assert.deepEqual([withOpenAi.llmProvider, withOpenAi.imageProvider, withOpenAi.ttsProvider], ["openai", "openai", "openai"]);
  assert.equal(loadConfig({ LLM_PROVIDER: "something" }).llmProvider, "none");
});

test("clips cost one credit per started minute", () => {
  assert.equal(clipCost(1), 1);
  assert.equal(clipCost(60), 1);
  assert.equal(clipCost(61), 2);
  assert.equal(clipCost(3600), 60);
});
