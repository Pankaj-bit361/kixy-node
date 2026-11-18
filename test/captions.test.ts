import assert from "node:assert/strict";
import { test } from "node:test";
import { assTime, buildAss, cleanText, groupWords, parseCaptionStyle } from "../src/media/captions.js";
import type { Word } from "../src/types.js";

const words: Word[] = [
  { start: 10.0, end: 10.3, text: "This" },
  { start: 10.35, end: 10.6, text: "is" },
  { start: 10.65, end: 11.0, text: "{wild}" },
  { start: 11.05, end: 11.4, text: "stuff." },
  { start: 13.0, end: 13.3, text: "Next" },
];

const dialogues = (ass: string, style: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:") && l.split(",")[3] === style);

test("ASS times", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(61.234), "0:01:01.23");
  assert.equal(assTime(3725.5), "1:02:05.50");
  assert.equal(assTime(-3), "0:00:00.00");
});

test("unknown styles fall back to bold; braces are stripped", () => {
  assert.equal(parseCaptionStyle("karaoke"), "karaoke");
  assert.equal(parseCaptionStyle("fancy"), "bold");
  assert.equal(cleanText("{big} news\\n"), "big news/n");
});

test("words group by count, length and pauses", () => {
  const groups = groupWords(words.map((w) => ({ ...w, text: cleanText(w.text) })), 3, 18, 0.6);
  assert.deepEqual(
    groups.map((g) => g.map((w) => w.text).join(" ")),
    ["This is wild", "stuff.", "Next"],
  );
});

test("bold style highlights each word in turn, times shifted to the clip", () => {
  const ass = buildAss(words, 10, 14, { style: "bold", font: "Inter" });
  assert.match(ass, /PlayResX: 720\nPlayResY: 1280/);
  assert.match(ass, /Style: Bold,Inter,66/);
  const lines = dialogues(ass, "Bold");
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith("Dialogue: 0,0:00:00.00,"));
  assert.ok(lines[0].endsWith("{\\c&H0000E5FF&\\fscx108\\fscy108}THIS{\\r} IS WILD"));
  assert.ok(lines[1].endsWith("THIS {\\c&H0000E5FF&\\fscx108\\fscy108}IS{\\r} WILD"));
});

test("clean and karaoke styles", () => {
  const clean = dialogues(buildAss(words, 10, 14, { style: "clean", font: "Inter" }), "Clean");
  assert.equal(clean[0].split(",,").pop(), "This is wild stuff.");
  const karaoke = dialogues(buildAss(words, 10, 14, { style: "karaoke", font: "Inter" }), "Karaoke");
  assert.match(karaoke[0], /\{\\kf35\}THIS \{\\kf30\}IS \{\\kf35\}WILD$/);
});

test("a hook card shows for the first 3 seconds, even with no captions", () => {
  const ass = buildAss(words, 10, 14, { style: "none", font: "Inter", hook: "Big {news}" });
  const hook = dialogues(ass, "Hook");
  assert.deepEqual(hook, ["Dialogue: 1,0:00:00.00,0:00:03.00,Hook,,0,0,0,,{\\fad(150,250)}Big news"]);
  assert.equal(dialogues(ass, "Bold").length, 0);
});

test("words outside the clip are left out and clamped at its end", () => {
  const ass = buildAss(words, 10.5, 11.2, { style: "clean", font: "Inter" });
  const lines = dialogues(ass, "Clean");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "Dialogue: 0,0:00:00.00,0:00:00.70,Clean,,0,0,0,,is wild stuff.");
});
