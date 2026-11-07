/**
 * Browser side of bookmarks: a small store over the server's data.
 *
 * Pages get the bookmarks from the server when they render, but the back
 * button (and Next's preserved routes) can show a page again exactly as it
 * was. So every change made in this tab is kept here, applied at once
 * (optimistically) and undone if the save fails; pages read the server data
 * through it and subscribe to it. Saves go out one at a time, so a quick
 * on → off → on can't land out of order.
 */

const changes = new Map<string, boolean>();
const listeners = new Set<() => void>();
let revision = 0;
let queue: Promise<unknown> = Promise.resolve();

const keyOf = (lessonId: string, index: number) => `${lessonId}:${index}`;

function changed() {
  revision++;
  listeners.forEach((l) => l());
}

async function post(lessonId: string, index: number, bookmarked: boolean) {
  let res: Response;
  try {
    res = await fetch("/api/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId, index, bookmarked }),
    });
  } catch {
    throw new Error("서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? "북마크를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
}

/**
 * Bookmarks a sentence (or removes it). Subscribers see the change at once; it is
 * undone, and this rejects with a message to show, if it couldn't be saved.
 */
export async function saveBookmark(lessonId: string, index: number, bookmarked: boolean): Promise<void> {
  const key = keyOf(lessonId, index);
  const before = changes.get(key);
  changes.set(key, bookmarked);
  changed();
  const run = queue.then(() => post(lessonId, index, bookmarked));
  queue = run.catch(() => {});
  try {
    await run;
  } catch (e) {
    // Only undo it if nothing newer was recorded meanwhile.
    if (changes.get(key) === bookmarked) {
      if (before === undefined) changes.delete(key);
      else changes.set(key, before);
      changed();
    }
    throw e;
  }
}

/** A lesson's bookmarked indexes from the server, updated with this tab's changes since. */
export function withLocalChanges(lessonId: string, indexes: readonly number[]): Set<number> {
  const set = new Set(indexes);
  const prefix = `${lessonId}:`;
  for (const [key, on] of changes) {
    if (!key.startsWith(prefix)) continue;
    const i = Number(key.slice(prefix.length));
    if (on) set.add(i);
    else set.delete(i);
  }
  return set;
}

/** Whether a sentence the server listed as bookmarked still is, after this tab's changes. */
export const stillBookmarked = (lessonId: string, index: number) => changes.get(keyOf(lessonId, index)) !== false;

/** For useSyncExternalStore: re-render when any bookmark changes in this tab. */
export function subscribeBookmarks(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Counts every change made in this tab (the store's snapshot); compare two readings to see if anything changed. */
export const bookmarkRevision = () => revision;

/** Resolves once every save sent so far has finished (successfully or not). */
export const bookmarksSettled = () => queue.then(() => undefined);
