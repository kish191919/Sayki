"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { CloseIcon, SearchIcon } from "@/components/icons";
import { parsePracticeStats, practiceSnapshot } from "@/lib/progress";
import type { ScriptListItem } from "@/lib/types";

/**
 * "내 스크립트": every script lesson made so far, newest first. Built to stay
 * compact as it grows: one dense row per script grouped by month, a page at a
 * time, and a title search once there are more than a page.
 */

/** Rows shown at first; "더 보기" adds another page. */
const PAGE = 10;

// Fixed time zone so the server render and the browser agree.
const PARTS = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

type Row = ScriptListItem & { month: string; day: string };

function withDate(s: ScriptListItem): Row {
  const t = Date.parse(s.createdAt);
  if (!Number.isFinite(t)) return { ...s, month: "날짜 없음", day: "" };
  const parts = PARTS.formatToParts(t);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { ...s, month: `${part("year")}년 ${part("month")}월`, day: `${part("day")}일` };
}

function formatDuration(sec: number | null) {
  if (sec == null) return null;
  sec = Math.round(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

const norm = (s: string) => s.normalize("NFC").toLowerCase();

function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

export default function ScriptList({ scripts }: { scripts: ScriptListItem[] }) {
  const rows = useMemo(() => scripts.map(withDate), [scripts]);
  const practice = useSyncExternalStore(subscribeStorage, practiceSnapshot, () => "");
  const stats = useMemo(() => parsePracticeStats(practice), [practice]);

  const [query, setQuery] = useState("");
  const [shown, setShown] = useState({ query: "", count: PAGE });

  const filtered = useMemo(() => {
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return rows;
    return rows.filter((r) => {
      const title = norm(r.title);
      return words.every((w) => title.includes(w));
    });
  }, [rows, query]);

  // A new search starts again from the first page.
  const limit = shown.query === query ? shown.count : PAGE;
  const visible = filtered.slice(0, limit);

  const groups = useMemo(() => {
    const out: { month: string; rows: Row[] }[] = [];
    for (const r of visible) {
      const last = out.at(-1);
      if (last?.month === r.month) last.rows.push(r);
      else out.push({ month: r.month, rows: [r] });
    }
    return out;
  }, [visible]);

  const searchable = scripts.length > PAGE;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="my-scripts" className="text-lg font-bold">
          내 스크립트{" "}
          {scripts.length > 0 && <span className="text-sm font-semibold tabular-nums text-muted">{scripts.length}</span>}
        </h2>
        {searchable && (
          <label className="flex h-9 w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 focus-within:border-accent sm:w-60">
            <SearchIcon size={15} className="shrink-0 text-muted" />
            <span className="sr-only">스크립트 제목으로 찾기</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="제목으로 찾기"
              autoComplete="off"
              className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button type="button" aria-label="검색어 지우기" onClick={() => setQuery("")} className="text-muted hover:text-ink">
                <CloseIcon size={14} />
              </button>
            )}
          </label>
        )}
      </div>

      {scripts.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          아직 만든 스크립트가 없어요. 위에서 첫 스크립트를 써 보세요.
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          ‘{query.trim()}’ 제목의 스크립트가 없어요.
        </p>
      ) : (
        <div className="mt-3 overflow-hidden rounded-2xl border border-line bg-surface">
          {groups.map((g) => (
            <div key={g.month}>
              <p className="border-b border-line bg-surface-2/60 px-4 py-1.5 text-xs font-semibold text-muted">{g.month}</p>
              <ul className="divide-y divide-line">
                {g.rows.map((r) => {
                  const practiced = stats.get(r.id)?.practiced ?? 0;
                  const done = r.sentenceCount > 0 && practiced >= r.sentenceCount;
                  const duration = formatDuration(r.durationSec);
                  return (
                    <li key={r.id}>
                      <Link
                        href={`/lesson/${r.id}`}
                        className="group flex items-center gap-3 px-4 py-2.5 transition hover:bg-surface-2"
                      >
                        <span className="w-8 shrink-0 text-xs font-semibold tabular-nums text-muted">{r.day}</span>
                        <span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
                          <span className="block truncate text-sm font-semibold group-hover:text-accent sm:flex-1">
                            {r.title}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1 text-xs tabular-nums text-muted sm:mt-0 sm:shrink-0">
                            <span>{r.sentenceCount}문장</span>
                            {duration && <span>· {duration}</span>}
                            {done ? (
                              <span className="font-semibold text-good">· 완주</span>
                            ) : (
                              practiced > 0 && <span className="text-accent">· {practiced}문장 연습함</span>
                            )}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {filtered.length > limit && (
            <button
              type="button"
              onClick={() => setShown({ query, count: limit + PAGE * 2 })}
              className="w-full border-t border-line px-4 py-2.5 text-sm font-semibold text-muted transition hover:bg-surface-2 hover:text-ink"
            >
              더 보기 <span className="tabular-nums">({filtered.length - limit}개 남음)</span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
