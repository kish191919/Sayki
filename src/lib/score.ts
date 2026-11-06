/**
 * Compares what the learner said (speech-recognition text) with the target
 * sentence, word by word. Runs in the browser.
 *
 * Speech recognisers spell things differently from captions ("I am" vs
 * "I'm", "everyday" vs "every day", "whether" vs "weather"), so matching is
 * deliberately lenient about spelling and strict about missing words.
 */

export type WordMark = { text: string; ok: boolean };
export type Attempt = { score: number; marks: WordMark[]; heard: string };

const NUMBER_WORDS: Record<string, string> = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five",
  "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten",
  "11": "eleven", "12": "twelve", "13": "thirteen", "14": "fourteen",
  "15": "fifteen", "16": "sixteen", "17": "seventeen", "18": "eighteen",
  "19": "nineteen", "20": "twenty", "30": "thirty", "40": "forty",
  "50": "fifty", "60": "sixty", "70": "seventy", "80": "eighty", "90": "ninety",
  "100": "hundred", "1st": "first", "2nd": "second", "3rd": "third",
};

const EQUIVALENTS: Record<string, string> = {
  okay: "ok",
  alright: "allright",
  mister: "mr",
  doctor: "dr",
};

/** Expanded on both sides, so "I'm" and "I am" compare equal. */
const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/g, "can not"],
  [/\bcannot\b/g, "can not"],
  [/\bwon't\b/g, "will not"],
  [/\bshan't\b/g, "shall not"],
  [/\bain't\b/g, "is not"],
  [/\blet's\b/g, "let us"],
  [/n't\b/g, " not"],
  [/'re\b/g, " are"],
  [/'ve\b/g, " have"],
  [/'ll\b/g, " will"],
  [/'m\b/g, " am"],
  [/'d\b/g, " would"],
  [/\b(it|that|what|there|here|he|she|who|where|how|this)'s\b/g, "$1 is"],
  [/\bgonna\b/g, "going to"],
  [/\bwanna\b/g, "want to"],
  [/\bgotta\b/g, "got to"],
  [/\bkinda\b/g, "kind of"],
  [/\bsorta\b/g, "sort of"],
  [/\blemme\b/g, "let me"],
  [/\bgimme\b/g, "give me"],
];

const HOMOPHONE_GROUPS = [
  ["to", "too", "two"], ["for", "four"], ["by", "buy", "bye"], ["no", "know"],
  ["right", "write"], ["see", "sea"], ["their", "there"], ["hear", "here"],
  ["one", "won"], ["eight", "ate"], ["new", "knew"], ["whole", "hole"],
  ["which", "witch"], ["wear", "where"], ["then", "than"], ["weak", "week"],
  ["meet", "meat"], ["peace", "piece"], ["red", "read"], ["son", "sun"],
  ["allowed", "aloud"], ["its", "it's"], ["your", "you're"],
];
const HOMOPHONE: Map<string, number> = new Map(
  HOMOPHONE_GROUPS.flatMap((g, i) => g.map((w) => [w, i] as [string, number])),
);

export function tokenize(text: string): string[] {
  let s = text.toLowerCase().replace(/[’‘`]/g, "'");
  for (const [re, rep] of CONTRACTIONS) s = s.replace(re, rep);
  return s
    .replace(/%/g, " percent ")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter(Boolean)
    .map((t) => NUMBER_WORDS[t] ?? EQUIVALENTS[t] ?? t);
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

const SOUNDEX_CODES: Record<string, string> = {
  b: "1", f: "1", p: "1", v: "1",
  c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2",
  d: "3", t: "3", l: "4", m: "5", n: "5", r: "6",
};

function soundex(word: string): string {
  const w = word.replace(/[^a-z]/g, "");
  if (!w) return "";
  let code = w[0];
  let last = SOUNDEX_CODES[w[0]] ?? "";
  for (let i = 1; i < w.length && code.length < 4; i++) {
    const c = SOUNDEX_CODES[w[i]] ?? "";
    if (c && c !== last) code += c;
    if (w[i] !== "h" && w[i] !== "w") last = c;
  }
  return code.padEnd(4, "0");
}

/** Lenient word match: apostrophes, homophones, one typo, sound-alikes. */
function same(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.replace(/'/g, "");
  const y = b.replace(/'/g, "");
  if (x === y) return true;
  const ga = HOMOPHONE.get(a) ?? HOMOPHONE.get(x);
  if (ga !== undefined && ga === (HOMOPHONE.get(b) ?? HOMOPHONE.get(y))) return true;
  if (x.length < 5 || y.length < 5) return false;
  const distance = editDistance(x, y);
  return distance <= 1 || (distance <= 2 && soundex(x) === soundex(y));
}

/**
 * Aligns expected and heard tokens (LCS that also allows "every day" ↔
 * "everyday" merges) and returns the indices of expected tokens that were said.
 */
function matchedIndices(expected: string[], heard: string[]): Set<number> {
  const n = expected.length;
  const m = heard.length;
  const dp: number[][] = Array.from({ length: n + 2 }, () => new Array<number>(m + 2).fill(0));
  const joinExp = (i: number) => (i + 1 < n ? expected[i] + expected[i + 1] : null);
  const joinHeard = (j: number) => (j + 1 < m ? heard[j] + heard[j + 1] : null);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(dp[i + 1][j], dp[i][j + 1]);
      if (same(expected[i], heard[j])) best = Math.max(best, dp[i + 1][j + 1] + 1);
      const je = joinExp(i);
      if (je && same(je, heard[j])) best = Math.max(best, dp[i + 2][j + 1] + 2);
      const jh = joinHeard(j);
      if (jh && same(expected[i], jh)) best = Math.max(best, dp[i + 1][j + 2] + 1);
      dp[i][j] = best;
    }
  }

  const hits = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const here = dp[i][j];
    const je = joinExp(i);
    const jh = joinHeard(j);
    if (same(expected[i], heard[j]) && here === dp[i + 1][j + 1] + 1) {
      hits.add(i);
      i++;
      j++;
    } else if (je && same(je, heard[j]) && here === dp[i + 2][j + 1] + 2) {
      hits.add(i);
      hits.add(i + 1);
      i += 2;
      j++;
    } else if (jh && same(expected[i], jh) && here === dp[i + 1][j + 2] + 1) {
      hits.add(i);
      i++;
      j += 2;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return hits;
}

export function scoreAttempt(target: string, heard: string): Attempt {
  const displayWords = target.split(/\s+/).filter(Boolean);
  const perWord = displayWords.map((w) => tokenize(w));
  const expected = perWord.flat();
  const heardTokens = tokenize(heard);
  const hits = matchedIndices(expected, heardTokens);

  let cursor = 0;
  const marks = displayWords.map((text, k) => {
    const count = perWord[k].length;
    let ok = true;
    for (let t = 0; t < count; t++) if (!hits.has(cursor + t)) ok = false;
    cursor += count;
    return { text, ok };
  });

  // Saying many extra words lowers the score a little.
  const denominator = Math.max(expected.length, heardTokens.length * 0.75, 1);
  const score = Math.min(100, Math.round((100 * hits.size) / denominator));
  return { score, marks, heard };
}

export function scoreTone(score: number): "great" | "good" | "low" {
  if (score >= 85) return "great";
  if (score >= 60) return "good";
  return "low";
}
