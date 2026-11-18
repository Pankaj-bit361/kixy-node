// Just enough PNG to read generated images and write grayscale pages, with no native code.
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface GrayImage {
  width: number;
  height: number;
  /** One byte per pixel, 0 black to 255 white, row by row. */
  pixels: Uint8Array;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function encodeGrayPng(img: GrayImage): Buffer {
  const { width, height, pixels } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode an 8-bit, non-interlaced PNG (gray, RGB, palette, with or without alpha) to grayscale,
 * with transparency composited over white.
 */
export function decodePngToGray(buf: Buffer): GrayImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | undefined;
  let alphaTable: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") alphaTable = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || channels === undefined) throw new Error("PNG has no usable header");
  if (depth !== 8 || interlace !== 0) throw new Error("only 8-bit, non-interlaced PNGs are supported");
  if (colorType === 3 && !palette) throw new Error("palette PNG without a palette");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is truncated");
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let r: number;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`bad PNG row filter ${filter}`);
      }
      cur[x] = r & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const p = x * channels;
      let lum: number;
      let alpha = 255;
      switch (colorType) {
        case 0: lum = cur[p]; break;
        case 4: lum = cur[p]; alpha = cur[p + 1]; break;
        case 2: lum = luma(cur[p], cur[p + 1], cur[p + 2]); break;
        case 6: lum = luma(cur[p], cur[p + 1], cur[p + 2]); alpha = cur[p + 3]; break;
        default: {
          const i = cur[p];
          const pal = palette as Buffer;
          lum = luma(pal[i * 3] ?? 0, pal[i * 3 + 1] ?? 0, pal[i * 3 + 2] ?? 0);
          alpha = alphaTable?.[i] ?? 255;
        }
      }
      out[y * width + x] = Math.round((lum * alpha + 255 * (255 - alpha)) / 255);
    }
    prev.set(cur);
  }
  return { width, height, pixels: out };
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
