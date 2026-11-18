// A minimal PDF writer: one full-page grayscale image per US Letter page.
import { deflateSync } from "node:zlib";
import type { GrayImage } from "./png.js";

export function pdfSafeTitle(title: string): string {
  return Array.from(title)
    .filter((c) => c === " " || (c >= "!" && c <= "~"))
    .filter((c) => !"()\\".includes(c))
    .join("");
}

export function buildPdf(pages: readonly GrayImage[], title: string): Buffer {
  const [pw, ph] = [612, 792];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let size = parts[0].length;
  const offsets: number[] = [];
  const push = (b: Buffer): void => {
    parts.push(b);
    size += b.length;
  };
  const obj = (...body: (string | Buffer)[]): void => {
    offsets.push(size);
    push(Buffer.from(`${offsets.length} 0 obj\n`, "latin1"));
    for (const b of body) push(typeof b === "string" ? Buffer.from(b, "latin1") : b);
    push(Buffer.from("\nendobj\n", "latin1"));
  };
  // Objects: 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const pageObj = (i: number): number => 4 + i * 3;
  obj("<< /Type /Catalog /Pages 2 0 R >>");
  obj(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  obj(`<< /Title (${pdfSafeTitle(title)}) /Producer (kixy-node) >>`);
  pages.forEach((img, i) => {
    const scale = Math.min(pw / img.width, ph / img.height);
    const [dw, dh] = [img.width * scale, img.height * scale];
    const [dx, dy] = [(pw - dw) / 2, (ph - dh) / 2];
    const content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm /Im${i} Do Q`;
    obj(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${pageObj(i) + 2} 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`,
    );
    obj(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const data = deflateSync(img.pixels);
    obj(
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
      data,
      "\nendstream",
    );
  });
  const xref = size;
  push(Buffer.from(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`, "latin1"));
  push(Buffer.from(offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join(""), "latin1"));
  push(Buffer.from(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
