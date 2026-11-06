"use client";

import { useSyncExternalStore } from "react";
import LessonCard from "@/components/LessonCard";
import { loadRecents, type RecentItem } from "@/lib/progress";

const EMPTY: RecentItem[] = [];
let cachedRaw: string | null = null;
let cachedList: RecentItem[] = EMPTY;

function getSnapshot(): RecentItem[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem("sayki:recents");
  } catch {
    return EMPTY;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = loadRecents();
  }
  return cachedList;
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** "Continue practicing" — lessons this browser opened before. */
export default function MyRecents() {
  const items = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  if (items.length === 0) return null;
  return (
    <section className="mx-auto max-w-[1400px] px-4 pb-4 pt-10 sm:px-6">
      <h2 className="mb-4 text-xl font-bold">이어서 연습하기</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.slice(0, 4).map((r) => (
          <LessonCard
            key={r.id}
            id={r.id}
            title={r.title}
            thumbnail={r.thumbnail}
            sentenceCount={r.sentenceCount}
            practiced={r.practiced}
          />
        ))}
      </div>
    </section>
  );
}
