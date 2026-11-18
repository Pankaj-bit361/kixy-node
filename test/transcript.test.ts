import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import { cueToWords, detectFormat, parseSubtitles, parseTimestamp, parseTranscript, parseWords } from "../src/media/transcript.js";
import { talkSrt, talkWords } from "./helpers.js";

test("timestamps in SRT and VTT forms", () => {
  assert.equal(parseTimestamp("00:01:02,500"), 62.5);
  assert.equal(parseTimestamp("01:02.250"), 62.25);
  assert.equal(parseTimestamp("1:00:00.000"), 3600);
  assert.equal(parseTimestamp("00:00:05"), 5);
  assert.equal(parseTimestamp("nonsense"), undefined);
});

test("timed words: accepts text or word, drops blanks, sorts", () => {
  const words = parseWords([
    { start: 2, end: 2.4, word: "world" },
    { start: 1, end: 1.5, text: " hello " },
    { start: 3, end: 3.1, text: "   " },
  ]);
  assert.deepEqual(words, [
    { start: 1, end: 1.5, text: "hello" },
    { start: 2, end: 2.4, text: "world" },
  ]);
});

test("timed words: rejects bad entries with a 400", () => {
  assert.throws(() => parseWords([{ start: "a", end: 1, text: "x" }]), (e) => e instanceof AppError && e.status === 400);
  assert.throws(() => parseWords([{ start: 2, end: 1, text: "x" }]), /end before its start/);
  assert.throws(() => parseWords("nope"), /must be an array/);
});

test("a cue's time is spread over its words by length", () => {
  const words = cueToWords(10, 12, "a longer word");
  assert.equal(words.length, 3);
  assert.equal(words[0].start, 10);
  assert.equal(words[2].end, 12);
  for (let i = 1; i < words.length; i++) assert.ok(Math.abs(words[i].start - words[i - 1].end) < 0.002);
  // "longer" (6 letters) gets more time than "a".
  assert.ok(words[1].end - words[1].start > words[0].end - words[0].start);
});

test("SRT with tags, entities and CRLF line endings", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Hello</i> &amp; {\\an8}welcome\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nsecond line\r\n";
  const words = parseSubtitles(srt);
  assert.deepEqual(
    words.map((w) => w.text),
    ["Hello", "&", "welcome", "second", "line"],
  );
  assert.equal(words[0].start, 1);
  assert.equal(words[4].end, 4);
});

test("WebVTT with a header, cue ids and settings", () => {
  const vtt = "WEBVTT\n\nintro\n00:01.000 --> 00:02.500 align:start position:10%\nOne two\n\n00:03.000 --> 00:04.000\n<v Sam>Three</v>\n";
  assert.equal(detectFormat(vtt), "vtt");
  const words = parseTranscript(vtt);
  assert.deepEqual(
    words.map((w) => w.text),
    ["One", "two", "Three"],
  );
  assert.equal(words[1].end, 2.5);
});

test("format detection and explicit formats", () => {
  assert.equal(detectFormat([]), "words");
  assert.equal(detectFormat("1\n00:00:01,000 --> 00:00:02,000\nhi\n"), "srt");
  assert.throws(() => detectFormat(42), /timed words/);
  assert.throws(() => parseTranscript([], "srt"), /must be text/);
  assert.throws(() => parseTranscript("x", "docx"), /words, srt or vtt/);
  assert.throws(() => parseSubtitles("00:00:xx --> 00:00:02,000\nhi\n"), /cue times on line 1/);
});

test("SRT and timed words of the same talk line up", () => {
  const fromSrt = parseTranscript(talkSrt(undefined, 1));
  const fromWords = parseTranscript(talkWords(undefined, 1));
  assert.equal(fromSrt.length, fromWords.length);
  assert.ok(Math.abs(fromSrt[fromSrt.length - 1].end - fromWords[fromWords.length - 1].end) < 1);
});
