const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * Removes non-speech annotations and speaker markers from a caption line:
 * "[Music]", "(Laughter)", "♪", ">> ", leading "- ".
 */
export function cleanCaptionText(raw: string): string {
  return decodeEntities(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]+/g, " ")
    .replace(/(^|\n)\s*(>>+|-)\s*/g, "$1")
    .replace(/>>+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A single caption word that is only an annotation, e.g. "[Music]". */
export function isAnnotationToken(t: string): boolean {
  return /^[[(].*[\])]$/.test(t) || /^[♪♫]+$/.test(t);
}
