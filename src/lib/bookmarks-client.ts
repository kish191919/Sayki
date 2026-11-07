/**
 * Browser side of bookmarks: changes made in this tab, applied at once and kept
 * across back/forward navigation (see `sentence-flags-client`).
 */

import { postJson, sentenceFlags } from "./sentence-flags-client";

const bookmarks = sentenceFlags(async (lessonId, indexes, bookmarked) => {
  // The API takes one sentence at a time; the room only ever changes one.
  for (const index of indexes) {
    await postJson(
      "/api/bookmarks",
      { lessonId, index, bookmarked },
      "북마크를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
  }
});

/**
 * Bookmarks a sentence (or removes it). Subscribers see the change at once; it is
 * undone, and this rejects with a message to show, if it couldn't be saved.
 */
export const saveBookmark = (lessonId: string, index: number, bookmarked: boolean) =>
  bookmarks.save(lessonId, [index], bookmarked);

/** A lesson's bookmarked indexes from the server, updated with this tab's changes since. */
export const withLocalChanges = bookmarks.withLocalChanges;

/** Whether a sentence the server listed as bookmarked still is, after this tab's changes. */
export const stillBookmarked = (lessonId: string, index: number) => bookmarks.changedTo(lessonId, index) !== false;

/** For useSyncExternalStore: re-render when any bookmark changes in this tab. */
export const subscribeBookmarks = bookmarks.subscribe;

/** Counts every change made in this tab (the store's snapshot); compare two readings to see if anything changed. */
export const bookmarkRevision = bookmarks.revision;

/** Resolves once every save sent so far has finished (successfully or not). */
export const bookmarksSettled = bookmarks.settled;
