import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { decodePngToGray, encodeGrayPng } from "../src/media/png.js";

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Write a PNG of any 8-bit colour type, using filter `y % 5` on row y so every filter is exercised. */
function encodePng(width: number, height: number, colorType: number, bpp: number, rows: Uint8Array[], extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  let prev: Uint8Array = new Uint8Array(stride);
  rows.forEach((row, y) => {
    const f = y % 5;
    out[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      out[y * (stride + 1) + 1 + i] = (row[i] - pred) & 0xff;
    }
    prev = row;
  });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), ...extra, chunk("IDAT", deflateSync(out)), chunk("IEND", Buffer.alloc(0))]);
}

test("grayscale PNGs round-trip", () => {
  const width = 7;
  const height = 5;
  const pixels = Uint8Array.from({ length: width * height }, (_, i) => (i * 37) % 256);
  const back = decodePngToGray(encodeGrayPng({ width, height, pixels }));
  assert.equal(back.width, width);
  assert.equal(back.height, height);
  assert.deepEqual(Array.from(back.pixels), Array.from(pixels));
});

test("RGB with every row filter decodes to luminance", () => {
  const width = 4;
  const height = 6;
  const rows = Array.from({ length: height }, (_, y) =>
    Uint8Array.from({ length: width * 3 }, (_, i) => (i % 3 === 0 ? 255 : 0) * ((y + i) % 2) + ((i * 11 + y * 7) % 50)),
  );
  const img = decodePngToGray(encodePng(width, height, 2, 3, rows));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rows[y].subarray(x * 3, x * 3 + 3);
      const want = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      assert.ok(Math.abs(img.pixels[y * width + x] - want) <= 1, `pixel ${x},${y}`);
    }
  }
});

test("transparent pixels become white, opaque black stays black", () => {
  const rows = [Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 255])];
  const img = decodePngToGray(encodePng(2, 1, 6, 4, rows));
  assert.deepEqual(Array.from(img.pixels), [255, 0]);
});

test("palette images with transparency", () => {
  const plte = chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255]));
  const trns = chunk("tRNS", Buffer.from([0]));
  const img = decodePngToGray(encodePng(3, 1, 3, 1, [Uint8Array.from([1, 0, 1])], [plte, trns]));
  assert.deepEqual(Array.from(img.pixels), [255, 255, 255]);
  const opaque = decodePngToGray(encodePng(2, 1, 3, 1, [Uint8Array.from([0, 1])], [plte]));
  assert.deepEqual(Array.from(opaque.pixels), [0, 255]);
});

test("things that are not 8-bit PNGs are refused", () => {
  assert.throws(() => decodePngToGray(Buffer.from("GIF89a")));
  const sixteen = encodePng(1, 1, 0, 1, [Uint8Array.from([1])]);
  sixteen[24] = 16; // bit depth byte in IHDR
  assert.throws(() => decodePngToGray(sixteen));
});
