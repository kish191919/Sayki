import { cleanCaptionText } from "./text";
import type { Cue } from "./types";

function toSeconds(s: string): number | null {
  const m = s.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return (
    Number(m[1] ?? 0) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(m[4].padEnd(3, "0")) / 1000
  );
}

/** Parses an .srt or .vtt subtitle file into cues. */
export function parseSubtitleFile(content: string): Cue[] {
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues: Cue[] = [];

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    const [a, b] = lines[timing].split("-->");
    const start = toSeconds(a);
    const end = toSeconds(b ?? "");
    if (start == null || end == null || end <= start) continue;

    let body = cleanCaptionText(lines.slice(timing + 1).join("\n"));
    if (!body) continue;

    // Roll-up captions repeat the previous line before adding new words.
    const prev = cues[cues.length - 1];
    if (prev) {
      if (body === prev.text) {
        prev.end = Math.max(prev.end, end);
        continue;
      }
      if (body.startsWith(prev.text + " ")) body = body.slice(prev.text.length + 1);
    }
    cues.push({ start, end, text: body });
  }

  return cues.sort((x, y) => x.start - y.start);
}
