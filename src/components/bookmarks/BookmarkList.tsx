"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRightIcon, BookmarkIcon, CloseIcon, PlayIcon, SearchIcon } from "@/components/icons";
import {
  bookmarkRevision,
  bookmarksSettled,
  saveBookmark,
  stillBookmarked,
  subscribeBookmarks,
} from "@/lib/bookmarks-client";
import type { BookmarkedSentence, BookmarkGroup } from "@/lib/types";

/** The bookmark revision this page's server data last caught up with (see `useCatchUp`). */
let syncedRevision = 0;

/**
 * The back button restores this page as it was first rendered. If bookmarks
 * changed in this tab since, fetch the page again once those saves have landed.
 */
function useCatchUp() {
  const router = useRouter();
  useEffect(() => {
    if (bookmarkRevision() === syncedRevision) return;
    let cancelled = false;
    void bookmarksSettled().then(() => {
      if (cancelled) return;
      syncedRevision = bookmarkRevision();
      router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [router]);
}

const norm = (s: string) => s.normalize("NFC").toLowerCase();

function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const practiceHref = (lessonId: string, index?: number) =>
  `/lesson/${lessonId}?only=bookmarks${index != null ? `&s=${index}` : ""}`;

type Removed = { lessonId: string; sentence: BookmarkedSentence };

/** "북마크": every bookmarked sentence, grouped by video, each a way back into practice. */
export default function BookmarkList({ groups }: { groups: BookmarkGroup[] }) {
  useCatchUp();
  // Removals (and their undo) show at once through the store; additions arrive with a refresh.
  useSyncExternalStore(subscribeBookmarks, bookmarkRevision, () => 0);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<{ text: string; bad: boolean; undo?: Removed } | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const flash = (next: { text: string; bad: boolean; undo?: Removed }) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = window.setTimeout(() => setNotice(null), next.undo || next.bad ? 6000 : 3000);
  };

  const remove = (lessonId: string, sentence: BookmarkedSentence) => {
    flash({ text: "북마크를 해제했어요.", bad: false, undo: { lessonId, sentence } });
    saveBookmark(lessonId, sentence.index, false).catch((e: Error) => flash({ text: e.message, bad: true }));
  };

  const undo = ({ lessonId, sentence }: Removed) => {
    setNotice(null);
    saveBookmark(lessonId, sentence.index, true).catch((e: Error) => flash({ text: e.message, bad: true }));
  };

  const live = groups
    .map((g) => ({ ...g, sentences: g.sentences.filter((s) => stillBookmarked(g.lesson.id, s.index)) }))
    .filter((g) => g.sentences.length > 0);
  const sentenceCount = live.reduce((n, g) => n + g.sentences.length, 0);

  const words = norm(query).split(/\s+/).filter(Boolean);
  const matches = (text: string) => {
    const t = norm(text);
    return words.every((w) => t.includes(w));
  };
  const shown = words.length
    ? live
        .map((g) =>
          matches(g.lesson.title)
            ? g
            : { ...g, sentences: g.sentences.filter((s) => matches(`${s.text} ${s.ko ?? ""}`)) },
        )
        .filter((g) => g.sentences.length > 0)
    : live;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">북마크</h1>
          <p className="mt-1 text-sm text-muted">
            {sentenceCount > 0
              ? `나중에 연습하려고 모아 둔 문장 ${sentenceCount}개 · 영상 ${live.length}개`
              : "나중에 연습할 문장을 모아 두는 곳이에요."}
          </p>
        </div>
        {live.length > 0 && (
          <Link
            href={practiceHref(live[0].lesson.id)}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent transition hover:bg-accent-strong"
          >
            <PlayIcon size={16} /> 북마크 문장 연습하기
          </Link>
        )}
      </div>

      {live.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-line bg-surface px-6 py-12 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <BookmarkIcon size={22} />
          </span>
          <p className="mt-4 font-semibold">아직 북마크한 문장이 없어요</p>
          <p className="mx-auto mt-1 max-w-sm break-keep text-sm text-muted">
            연습 화면에서 다시 연습하고 싶은 문장의 <span className="font-semibold text-ink">북마크</span> 버튼을 누르거나{" "}
            <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-ink">B</kbd>{" "}
            키를 눌러 보세요. 여기에 모여요.
          </p>
          <Link
            href="/lessons"
            className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline"
          >
            내 레슨으로 가기 <ArrowRightIcon size={16} />
          </Link>
        </div>
      ) : (
        <>
          <label className="mt-6 flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm focus-within:border-accent">
            <SearchIcon size={18} className="shrink-0 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="문장, 해석, 영상 제목으로 찾기"
              aria-label="북마크 검색"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
            />
          </label>

          {shown.length === 0 && <p className="mt-8 text-center text-sm text-muted">‘{query.trim()}’에 맞는 북마크가 없어요.</p>}

          <div className="mt-5 space-y-5">
            {shown.map((g) => (
              <section key={g.lesson.id} className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                <header className="flex items-center gap-3 border-b border-line p-3 sm:p-4">
                  <Link
                    href={`/lesson/${g.lesson.id}`}
                    className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-surface-2 sm:w-28"
                    tabIndex={-1}
                    aria-hidden="true"
                  >
                    {g.lesson.thumbnail ? (
                      <Image src={g.lesson.thumbnail} alt="" fill sizes="112px" className="object-cover" unoptimized />
                    ) : (
                      <span className="flex h-full items-center justify-center text-xs font-semibold text-muted">내 영상</span>
                    )}
                  </Link>
                  <div className="min-w-0 flex-1">
                    <h2 className="line-clamp-2 text-sm font-bold leading-snug sm:text-base">
                      <Link href={`/lesson/${g.lesson.id}`} className="hover:text-accent">
                        {g.lesson.title}
                      </Link>
                    </h2>
                    <p className="mt-0.5 text-xs text-muted">
                      북마크 {g.sentences.length}문장 · 전체 {g.lesson.sentenceCount}문장
                    </p>
                  </div>
                  <Link
                    href={practiceHref(g.lesson.id)}
                    className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full border border-line px-3 text-xs font-semibold transition hover:border-accent hover:text-accent sm:text-sm"
                  >
                    <span>
                      연습<span className="hidden sm:inline">하기</span>
                    </span>
                    <ArrowRightIcon size={14} />
                  </Link>
                </header>
                <ol className="divide-y divide-line">
                  {g.sentences.map((s) => (
                    <li key={s.index} className="relative">
                      <Link
                        href={practiceHref(g.lesson.id, s.index)}
                        className="flex gap-3 py-3 pl-4 pr-12 transition hover:bg-surface-2"
                      >
                        <span className="w-10 shrink-0 pt-0.5 text-xs tabular-nums text-muted">{formatTime(s.start)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold leading-snug" lang="en">
                            {s.text}
                          </span>
                          {s.ko && <span className="mt-0.5 block break-keep text-sm text-muted">{s.ko}</span>}
                        </span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => remove(g.lesson.id, s)}
                        aria-label="북마크 해제"
                        title="북마크 해제"
                        className="absolute right-2 top-2 inline-flex size-9 items-center justify-center rounded-full text-accent transition hover:bg-accent-soft"
                      >
                        <BookmarkIcon size={18} filled />
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        </>
      )}

      {notice && (
        <div
          role="status"
          className={`fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold shadow-lg sm:bottom-6 ${
            notice.bad ? "bg-bad text-on-accent" : "bg-ink text-bg"
          }`}
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.undo && (
            <button type="button" onClick={() => undo(notice.undo!)} className="shrink-0 underline underline-offset-2">
              되돌리기
            </button>
          )}
          <button type="button" onClick={() => setNotice(null)} aria-label="닫기" className="shrink-0 opacity-70 hover:opacity-100">
            <CloseIcon size={16} />
          </button>
        </div>
      )}
    </>
  );
}
