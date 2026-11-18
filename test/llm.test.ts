import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicRequest, anthropicText, noLlm, openAiChatLlm, parseJsonLoose } from "../src/ai/llm.js";

test("JSON is found inside prose or code fences", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go:\n```json\n{"a": [1, 2]}\n```'), { a: [1, 2] });
  assert.throws(() => parseJsonLoose("no json here"), /no JSON/);
  assert.throws(() => parseJsonLoose("{ nope }"), /not valid JSON/);
});

test("Claude requests ask for JSON matching the schema", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  const req = anthropicRequest("claude-sonnet-5-5", "sys", "hello", schema);
  assert.equal(req.model, "claude-sonnet-5-5");
  assert.equal(req.system, "sys");
  assert.deepEqual(req.messages, [{ role: "user", content: "hello" }]);
  assert.deepEqual(req.output_config, { effort: "medium", format: { type: "json_schema", schema } });
  assert.ok(req.max_tokens >= 1000);
});

function message(over: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...over,
  } as Anthropic.Message;
}

test("Claude replies: text, refusals and truncation", () => {
  assert.equal(anthropicText(message({ content: [{ type: "text", text: '{"a":"b"}', citations: null }] as Anthropic.ContentBlock[] })), '{"a":"b"}');
  assert.throws(() => anthropicText(message({ stop_reason: "refusal" })), /declined/);
  assert.throws(() => anthropicText(message({ stop_reason: "max_tokens" })), /ran out/);
});

test("an OpenAI-compatible chat API is called with the schema in the prompt", async () => {
  let seen: { url: string; body: Record<string, unknown>; auth: string } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const llm = openAiChatLlm({ apiKey: "k", baseUrl: "https://llm.example/v1/", model: "m" }, fakeFetch);
  assert.deepEqual(await llm.json("sys", "user", { type: "object" }), { ok: true });
  assert.equal(seen?.url, "https://llm.example/v1/chat/completions");
  assert.equal(seen?.auth, "Bearer k");
  assert.equal(seen?.body.model, "m");
  assert.deepEqual(seen?.body.response_format, { type: "json_object" });

  const failing = openAiChatLlm(
    { apiKey: "k", baseUrl: "https://llm.example/v1", model: "m" },
    (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch,
  );
  await assert.rejects(failing.json("s", "u", {}), /401: bad key/);
});

test("with no model configured, calls fail clearly", async () => {
  assert.equal(noLlm.available, false);
  await assert.rejects(noLlm.json("s", "u", {}), /no language model/);
});
