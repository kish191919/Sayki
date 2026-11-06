import type { Cue, Sentence, Word } from "./types";

/** Spreads a caption line's words across its time range, weighted by length. */
export function interpolateWords(text: string, start: number, end: number): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const total = tokens.reduce((n, t) => n + t.length + 1, 0);
  const dur = Math.max(0.01, end - start);
  let acc = 0;
  return tokens.map((t) => {
    const ws = start + (dur * acc) / total;
    acc += t.length + 1;
    const we = start + (dur * (acc - 1)) / total;
    return { text: t, start: ws, end: we };
  });
}

/** Flattens cues into one time-ordered word stream. */
export function cuesToWords(cues: Cue[]): Word[] {
  const words: Word[] = [];
  for (const c of cues) {
    if (c.words?.length) words.push(...c.words);
    else words.push(...interpolateWords(c.text, c.start, c.end));
  }
  words.sort((a, b) => a.start - b.start);
  for (let i = 0; i < words.length - 1; i++) {
    const next = words[i + 1];
    if (words[i].end > next.start) {
      words[i].end = Math.max(words[i].start + 0.05, next.start);
    }
  }
  return words;
}

const ABBREVIATIONS = new Set([
  "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "vs.", "etc.",
  "e.g.", "i.e.", "u.s.", "u.k.", "a.m.", "p.m.", "no.", "mt.",
]);

type Limits = {
  maxWords: number;
  maxSeconds: number;
  minWords: number;
  /** A pause this long ends a sentence. */
  pauseBreak: number;
};

/** Human-made captions: punctuation decides, pauses are a fallback. */
const PUNCTUATED: Limits = { maxWords: 24, maxSeconds: 11, minWords: 3, pauseBreak: 1.0 };
/** Auto captions have no punctuation: lean on pauses and keep chunks short. */
const UNPUNCTUATED: Limits = { maxWords: 16, maxSeconds: 7, minWords: 5, pauseBreak: 0.45 };
/** A pause this long always ends a sentence, however short. */
const HARD_PAUSE_BREAK = 2.5;

function isTerminal(word: string): boolean {
  const t = word.toLowerCase().replace(/["'”’)\]]+$/, "");
  if (ABBREVIATIONS.has(t)) return false;
  return /[.?!…]$/.test(t);
}

function isSoftBreak(word: string): boolean {
  return /[,;:—–]["'”’)]*$/.test(word);
}

function isPunctuated(words: Word[]): boolean {
  const terminals = words.filter((w) => isTerminal(w.text)).length;
  return words.length < 40 ? terminals > 0 : terminals / words.length >= 1 / 40;
}

/** Picks where to cut an over-long run: last comma, else the biggest pause. */
function findCut(run: Word[], limits: Limits): number {
  const from = Math.max(limits.minWords - 1, Math.floor(run.length * 0.4));
  for (let k = run.length - 2; k >= from; k--) {
    if (isSoftBreak(run[k].text)) return k + 1;
  }
  let best = 0.15;
  let cut = run.length;
  for (let k = from; k < run.length - 1; k++) {
    const gap = run[k + 1].start - run[k].end;
    if (gap > best) {
      best = gap;
      cut = k + 1;
    }
  }
  return cut;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function tidy(text: string): string {
  const t = text.replace(/\s+([,.?!;:])/g, "$1").replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Groups a word stream into practice sentences with playback ranges. */
export function segmentWords(words: Word[]): Sentence[] {
  const limits = isPunctuated(words) ? PUNCTUATED : UNPUNCTUATED;
  const groups: Word[][] = [];
  let run: Word[] = [];
  const flush = (n = run.length) => {
    if (n > 0) {
      groups.push(run.slice(0, n));
      run = run.slice(n);
    }
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    run.push(w);
    const next = words[i + 1];
    const gap = next ? next.start - w.end : Infinity;
    const duration = w.end - run[0].start;

    if (gap >= HARD_PAUSE_BREAK) flush();
    else if (isTerminal(w.text) && (run.length >= 2 || gap > 0.5)) flush();
    else if (gap >= limits.pauseBreak && run.length >= limits.minWords) flush();
    else if (run.length >= limits.maxWords || duration >= limits.maxSeconds) flush(findCut(run, limits));
  }
  flush();

  // Pad each sentence into the silence around it, splitting shared gaps so
  // neighbouring sentences never overlap.
  return groups.map((g, i) => {
    const first = g[0];
    const last = g[g.length - 1];
    const prev = i > 0 ? groups[i - 1][groups[i - 1].length - 1] : null;
    const next = i < groups.length - 1 ? groups[i + 1][0] : null;
    const gapBefore = prev ? Math.max(0, first.start - prev.end) : Infinity;
    const gapAfter = next ? Math.max(0, next.start - last.end) : Infinity;
    const start = Math.max(0, first.start - Math.min(0.15, gapBefore * 0.4));
    const end = last.end + Math.min(0.35, gapAfter * 0.6);
    return {
      index: i,
      start: round(start),
      end: round(end),
      text: tidy(g.map((w) => w.text).join(" ")),
    };
  });
}

export function buildSentences(cues: Cue[]): Sentence[] {
  return segmentWords(cuesToWords(cues));
}

/**
 * Assigns each translated cue to the sentence it overlaps most.
 * Returns how many sentences received a translation.
 */
export function attachTranslations(sentences: Sentence[], cues: Cue[]): number {
  const buckets: string[][] = sentences.map(() => []);
  let lo = 0;
  for (const c of cues) {
    while (lo < sentences.length && sentences[lo].end <= c.start) lo++;
    let best = -1;
    let bestOverlap = 0;
    for (let i = Math.max(0, lo - 1); i < sentences.length; i++) {
      const s = sentences[i];
      if (s.start >= c.end) break;
      const overlap = Math.min(c.end, s.end) - Math.max(c.start, s.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    }
    if (best >= 0 && c.text) buckets[best].push(c.text);
  }
  let count = 0;
  sentences.forEach((s, i) => {
    if (buckets[i].length) {
      s.ko = buckets[i].join(" ").replace(/\s+/g, " ").trim();
      count++;
    }
  });
  return count;
}
