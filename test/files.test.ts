import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync, inflateSync } from "node:zlib";
import { placeholderSvg } from "../src/ai/images.js";
import { PAGE, placeholderLineart, toLineart } from "../src/media/lineart.js";
import { buildPdf, pdfSafeTitle } from "../src/media/pdf.js";
import { buildZip } from "../src/media/zip.js";
import type { GrayImage } from "../src/media/png.js";

/** Read a ZIP back through its central directory. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(buf.subarray(dataStart, dataStart + size)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test("ZIP files read back with their names and contents", () => {
  const zip = buildZip(
    [
      { name: "a.txt", data: Buffer.from("hello ".repeat(100)) },
      { name: "pages/ünï.bin", data: Buffer.from([0, 1, 2, 3, 255]) },
    ],
    new Date(2024, 4, 6, 12, 30, 10),
  );
  const files = readZip(zip);
  assert.deepEqual([...files.keys()], ["a.txt", "pages/ünï.bin"]);
  assert.equal(files.get("a.txt")?.toString(), "hello ".repeat(100));
  assert.deepEqual([...(files.get("pages/ünï.bin") ?? [])], [0, 1, 2, 3, 255]);
});

function gray(width: number, height: number, v: number): GrayImage {
  return { width, height, pixels: new Uint8Array(width * height).fill(v) };
}

test("PDFs have one image page per input, a valid xref and the title", () => {
  const pdf = buildPdf([gray(20, 26, 0), gray(26, 20, 255)], "My (Book) \\ ✓");
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/Title \(My Book  \)/);
  assert.equal((text.match(/\/Type \/Page /g) ?? []).length, 2);
  // Every xref offset points at the start of its object.
  const xref = text.lastIndexOf("\nxref\n") + 1;
  const startxref = Number(text.slice(text.lastIndexOf("startxref") + 10).trim().split("\n")[0]);
  assert.equal(startxref, xref);
  const entries = text.slice(xref).split("\n").slice(3).filter((l) => / 00000 n/.test(l));
  entries.forEach((line, i) => {
    const off = Number(line.slice(0, 10));
    assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  });
  // The images are Flate-compressed gray pixels.
  const img = text.indexOf("/Subtype /Image");
  assert.ok(img > 0);
  assert.match(text.slice(img, img + 200), /\/ColorSpace \/DeviceGray/);
  const start = text.indexOf("stream\n", img) + 7;
  const len = Number(/\/Length (\d+)/.exec(text.slice(img - 50, start))?.[1]);
  assert.equal(inflateSync(pdf.subarray(start, start + len)).length, 20 * 26);
  assert.equal(pdfSafeTitle("a(b)c\\d é"), "abcd ");
});

test("line art is page-sized pure black and white", () => {
  const art = placeholderLineart(3);
  assert.equal(art.width, PAGE.width);
  assert.equal(art.height, PAGE.height);
  const values = new Set(art.pixels);
  assert.deepEqual([...values].sort((a, b) => a - b), [0, 255]);
  const black = art.pixels.filter((v) => v === 0).length;
  assert.ok(black > 1000 && black < art.pixels.length / 4);
  assert.notDeepEqual(placeholderLineart(0).pixels, placeholderLineart(1).pixels);
});

test("images become thresholded line art centred on the page", () => {
  const src = gray(100, 50, 200);
  for (let x = 0; x < 100; x++) src.pixels[25 * 100 + x] = 10;
  const art = toLineart(src);
  assert.equal(art.width, PAGE.width);
  // A wide image fits the page width and sits in the middle vertically.
  assert.equal(art.pixels[0], 255);
  const mid = Math.floor(PAGE.height / 2);
  const blackRows = [];
  for (let y = mid - 40; y < mid + 40; y++) if (art.pixels[y * PAGE.width + PAGE.width / 2 | 0] === 0) blackRows.push(y);
  assert.ok(blackRows.length > 0, "the dark line survives");
  assert.ok(art.pixels.every((v) => v === 0 || v === 255));
});

test("placeholder images are SVG cards with the prompt escaped", () => {
  const svg = placeholderSvg("cats & <dogs>", 0, "portrait", "Inter");
  assert.ok(svg.startsWith("<svg "));
  assert.match(svg, /width="512" height="768"/);
  assert.match(svg, /cats &amp; &lt;dogs&gt;/);
  assert.doesNotMatch(svg, /<dogs>/);
});
