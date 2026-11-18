/** One spoken word with absolute times, in seconds, in the source video. */
export interface Word {
  start: number;
  end: number;
  text: string;
}

/** A sentence-ish run of words, used in prompts and to snap clip edges. */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** A moment the highlight picker chose. */
export interface ClipPlan {
  start: number;
  end: number;
  title: string;
  hook: string;
  score: number;
  reason: string;
}

const SENTENCE_END = /[.?!]$/;

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trimEnd());
}

/** Group words into segments: break on sentence punctuation, on pauses longer than `pause`, or at `maxLen` seconds. */
export function segments(words: readonly Word[], pause: number, maxLen: number): Segment[] {
  const out: Segment[] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const gap = next ? next.start - w.end : Number.POSITIVE_INFINITY;
    const tooLong = w.end - cur[0].start >= maxLen;
    if (endsSentence(w.text) || gap > pause || tooLong) {
      out.push({ start: cur[0].start, end: w.end, text: cur.map((x) => x.text.trim()).join(" ") });
      cur = [];
    }
  });
  return out;
}

/** The words spoken inside [start, end], with a little slack at both edges. */
export function wordsIn(words: readonly Word[], start: number, end: number): Word[] {
  return words.filter((w) => w.end > start + 0.05 && w.start < end - 0.05).map((w) => ({ ...w }));
}
