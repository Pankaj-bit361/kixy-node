import assert from "node:assert/strict";
import { test } from "node:test";
import { framing, OUTPUT, parseCropMode } from "../src/media/framing.js";

test("output is vertical 720x1280", () => {
  assert.deepEqual({ ...OUTPUT }, { width: 720, height: 1280, fps: 30 });
});

test("a 16:9 source gets a full-height 9:16 window around the chosen point", () => {
  const src = { width: 1920, height: 1080 };
  assert.deepEqual(framing(src, "center", 0.1), { kind: "crop", x: 657, y: 0, width: 606, height: 1080 });
  assert.deepEqual(framing(src, "auto", 0.5), { kind: "crop", x: 657, y: 0, width: 606, height: 1080 });
  // Pushed to the edges, the window stays inside the frame.
  assert.deepEqual(framing(src, "auto", 0), { kind: "crop", x: 0, y: 0, width: 606, height: 1080 });
  assert.deepEqual(framing(src, "auto", 1), { kind: "crop", x: 1314, y: 0, width: 606, height: 1080 });
  assert.deepEqual(framing(src, "auto", 5), framing(src, "auto", 1));
});

test("a source narrower than 9:16 is cropped top and bottom", () => {
  const f = framing({ width: 720, height: 1600 }, "auto", 0.3);
  assert.deepEqual(f, { kind: "crop", x: 0, y: 160, width: 720, height: 1280 });
  assert.deepEqual(framing({ width: 1080, height: 1920 }, "center", 0.5), { kind: "crop", x: 0, y: 0, width: 1080, height: 1920 });
});

test("fit mode and unknown modes", () => {
  assert.deepEqual(framing({ width: 1920, height: 1080 }, "fit", 0.5), { kind: "fit" });
  assert.equal(parseCropMode("sideways"), "auto");
  assert.equal(parseCropMode("fit"), "fit");
});
