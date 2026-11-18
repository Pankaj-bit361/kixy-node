// Captions as ASS subtitles for a 720x1280 frame, word by word, ready to burn in.
import type { Word } from "../types.js";

export const CAPTION_STYLES = ["bold", "clean", "karaoke", "none"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export function parseCaptionStyle(s: unknown): CaptionStyle {
  return (CAPTION_STYLES as readonly unknown[]).includes(s) ? (s as CaptionStyle) : "bold";
}

export interface CaptionOptions {
  style: CaptionStyle;
  font: string;
  /** Title card at the top for the first seconds. */
  hook?: string;
}

/** Seconds to `h:mm:ss.cc`. */
export function assTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs % 100)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Remove what ASS would read as override tags or line breaks. */
export function cleanText(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/[\n\r]/g, " ").trim();
}

/** Split words into short on-screen groups. */
export function groupWords(words: readonly Word[], maxWords: number, maxChars: number, maxGap: number): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    const last = cur[cur.length - 1];
    const gap = last ? w.start - last.end : 0;
    if (cur.length > 0 && (cur.length >= maxWords || chars > maxChars || gap > maxGap)) {
      groups.push(cur);
      cur = [];
    }
    cur.push({ ...w });
    if (/[.?!,]$/.test(w.text.trimEnd())) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

const HIGHLIGHT = "&H0000E5FF";

/** Build an ASS file. `words` carry absolute source times; `clipStart` shifts them to 0. */
export function buildAss(words: readonly Word[], clipStart: number, clipEnd: number, opts: CaptionOptions): string {
  const font = opts.font;
  let out = "";
  out += "[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n";
  out +=
    "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n";
  out += `Style: Bold,${font},66,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,6,2,2,50,50,300,1\n`;
  out += `Style: Clean,${font},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,2,3,2,60,60,260,1\n`;
  out += `Style: Karaoke,${font},62,${HIGHLIGHT},&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,5,2,2,50,50,300,1\n`;
  out += `Style: Hook,${font},52,&H00000000,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,18,0,8,60,60,150,1\n\n`;
  out += "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  const dur = Math.max(0, clipEnd - clipStart);
  const hook = opts.hook === undefined ? "" : cleanText(opts.hook);
  if (hook) {
    out += `Dialogue: 1,${assTime(0)},${assTime(Math.min(dur, 3))},Hook,,0,0,0,,{\\fad(150,250)}${hook}\n`;
  }
  if (opts.style === "none") return out;

  const rel: Word[] = words
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => ({ start: Math.max(0, w.start - clipStart), end: Math.min(w.end - clipStart, dur), text: cleanText(w.text) }))
    .filter((w) => w.text !== "");

  const [maxWords, maxChars] = opts.style === "clean" ? [6, 32] : [3, 18];
  const groups = groupWords(rel, maxWords, maxChars, 0.6);
  groups.forEach((g, gi) => {
    const nextStart = gi + 1 < groups.length ? groups[gi + 1][0].start : dur;
    const lastEnd = g[g.length - 1].end;
    // Hold the group until the next one starts if the gap is short, so text doesn't flicker.
    const gEnd = Math.min(nextStart - lastEnd < 0.4 ? nextStart : lastEnd + 0.15, dur);
    switch (opts.style) {
      case "bold":
        g.forEach((w, i) => {
          const e = Math.max(i + 1 < g.length ? g[i + 1].start : gEnd, w.start + 0.05);
          const text = g
            .map((x, j) => {
              const t = x.text.toUpperCase();
              return j === i ? `{\\c${HIGHLIGHT}&\\fscx108\\fscy108}${t}{\\r}` : t;
            })
            .join(" ");
          out += `Dialogue: 0,${assTime(w.start)},${assTime(e)},Bold,,0,0,0,,${text}\n`;
        });
        break;
      case "clean":
        out += `Dialogue: 0,${assTime(g[0].start)},${assTime(gEnd)},Clean,,0,0,0,,${g.map((w) => w.text).join(" ")}\n`;
        break;
      case "karaoke": {
        const text = g
          .map((w, i) => {
            const e = i + 1 < g.length ? g[i + 1].start : w.end;
            const cs = Math.max(1, Math.round((e - w.start) * 100));
            return `{\\kf${cs}}${w.text.toUpperCase()}`;
          })
          .join(" ");
        out += `Dialogue: 0,${assTime(g[0].start)},${assTime(gEnd)},Karaoke,,0,0,0,,${text}\n`;
        break;
      }
    }
  });
  return out;
}
