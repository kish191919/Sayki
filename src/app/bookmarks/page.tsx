import type { Metadata } from "next";
import { Suspense } from "react";
import BookmarkList from "@/components/bookmarks/BookmarkList";
import { loadBookmarkGroups } from "@/lib/bookmarks";
import type { BookmarkGroup } from "@/lib/types";

export const metadata: Metadata = { title: "북마크" };

export default function BookmarksPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <Suspense fallback={<BookmarksSkeleton />}>
        <Bookmarks />
      </Suspense>
    </div>
  );
}

async function Bookmarks() {
  let groups: BookmarkGroup[];
  try {
    groups = await loadBookmarkGroups();
  } catch (e) {
    console.error("bookmarks load failed", e);
    return (
      <>
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">북마크</h1>
        <p className="mt-3 text-sm text-muted">북마크를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
      </>
    );
  }
  return <BookmarkList groups={groups} />;
}

function BookmarksSkeleton() {
  return (
    <>
      <div className="h-9 w-28 animate-pulse rounded-lg bg-surface-2" />
      <div className="mt-2 h-4 w-56 animate-pulse rounded bg-surface-2" />
      <div className="mt-6 h-11 animate-pulse rounded-xl bg-surface-2" />
      {[0, 1].map((k) => (
        <div key={k} className="mt-5 h-56 animate-pulse rounded-2xl bg-surface-2" />
      ))}
    </>
  );
}
