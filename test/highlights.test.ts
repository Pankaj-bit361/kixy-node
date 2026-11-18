import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPrompt,
  finalize,
  hookFrom,
  overlap,
  parsePlans,
  pickHeuristic,
  pickWithLlm,
  sanitizePickOptions,
  titleFrom,
} from "../src/ai/highlights.js";
import { segments, wordsIn } from "../src/types.js";
import { fakeLlm, talkWords } from "./helpers.js";

const opts = sanitizePickOptions({ count: 5, minLen: 15, maxLen: 40 });

test("pick options are kept in range", () => {
  assert.deepEqual(sanitizePickOptions({ count: 99, minLen: 1, maxLen: 999 }), { count: 20, minLen: 5, maxLen: 180 });
  assert.deepEqual(sanitizePickOptions({ count: 0, minLen: 60, maxLen: 30 }), { count: 1, minLen: 60, maxLen: 61 });
  assert.deepEqual(sanitizePickOptions({}), { count: 10, minLen: 15, maxLen: 60 });
});

test("segments break on sentence ends and pauses", () => {
  const segs = segments(talkWords(undefined, 1), 0.9, 20);
  assert.equal(segs.length, 20);
  assert.equal(segs[0].text, "Nobody tells you the biggest mistake people make with money.");
});

test("the heuristic picks non-overlapping clips of the right length from a transcript", () => {
  const words = talkWords();
  const duration = words[words.length - 1].end + 1;
  const plans = finalize(pickHeuristic(words, [], duration, opts), words, duration, opts);
  assert.ok(plans.length >= 3 && plans.length <= 5);
  for (const p of plans) {
    assert.ok(p.end - p.start >= 15 - 0.01 && p.end - p.start <= 40 + 0.01, `length ${p.end - p.start}`);
    assert.ok(p.score >= 0 && p.score <= 100);
    assert.ok(p.title.length > 0);
    assert.match(p.reason, /^Picked automatically/);
  }
  for (let i = 0; i < plans.length; i++) for (let j = i + 1; j < plans.length; j++) assert.ok(overlap(plans[i], plans[j]) <= 0.3);
  for (let i = 1; i < plans.length; i++) assert.ok(plans[i - 1].score >= plans[i].score);
});

test("hooks and titles come from the clip's own words", () => {
  const words = talkWords(undefined, 1).slice(0, 12);
  assert.equal(hookFrom(words), "Nobody tells you the biggest mistake people");
  assert.ok(titleFrom(words).length > 0);
});

test("with no transcript, loud stretches win", () => {
  const loudness = Array.from({ length: 120 }, (_, i) => (i >= 60 && i < 80 ? 0.9 : 0.1));
  const plans = finalize(pickHeuristic([], loudness, 120, opts), [], 120, opts);
  assert.ok(plans.length > 0);
  assert.ok(plans[0].start >= 50 && plans[0].start <= 70, `best starts at ${plans[0].start}`);
  assert.equal(plans[0].hook, "");
});

test("a very short video becomes one clip", () => {
  const plans = finalize(pickHeuristic([], [], 8, opts), [], 8, opts);
  assert.deepEqual(
    plans.map((p) => [p.start, p.end]),
    [[0, 8]],
  );
});

test("model answers are cleaned: bad clips dropped, fields clamped", () => {
  const plans = parsePlans({
    clips: [
      { start: 1, end: 20, title: "x".repeat(200), hook: "h", score: 140, reason: "r" },
      { start: "1", end: 20 },
      { start: 30, end: 50, score: -5 },
    ],
  });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].title.length, 80);
  assert.equal(plans[0].score, 100);
  assert.equal(plans[1].score, 0);
  assert.deepEqual(parsePlans("nope"), []);
});

test("finalize snaps model clips to word edges and drops overlaps", () => {
  const words = talkWords();
  const duration = words[words.length - 1].end + 1;
  const plans = finalize(
    [
      { start: 0.5, end: 18.2, title: "a", hook: "", score: 80, reason: "" },
      { start: 2, end: 19, title: "b", hook: "", score: 70, reason: "" },
      { start: 40, end: 400, title: "c", hook: "", score: 60, reason: "" },
    ],
    words,
    duration,
    opts,
  );
  assert.deepEqual(
    plans.map((p) => p.title),
    ["a", "c"],
  );
  assert.equal(plans[0].start, 0.9);
  assert.ok(plans[1].end - plans[1].start <= 40);
});

test("the model sees the transcript as timed lines and its answer is parsed", async () => {
  const words = talkWords(undefined, 1);
  const llm = fakeLlm((system, user, schema) => {
    assert.match(system, /short-form video editor/);
    assert.match(user, /\[1\.0 - [\d.]+\] Nobody tells you/);
    assert.equal((schema as { required: string[] }).required[0], "clips");
    return { clips: [{ start: 1, end: 20, title: "Money", hook: "Stop waiting", score: 77, reason: "Strong open" }] };
  });
  const plans = await pickWithLlm(llm, words, 120, opts);
  assert.equal(plans[0].title, "Money");
  assert.equal(llm.calls, 1);
  assert.match(buildPrompt(segments(words, 0.9, 20), 120, opts), /between 15 and 40 seconds/);
});

test("wordsIn keeps words inside a range", () => {
  const words = talkWords(undefined, 1);
  const inside = wordsIn(words, 5, 10);
  assert.ok(inside.length > 0);
  assert.ok(inside.every((w) => w.end > 5 && w.start < 10));
});
