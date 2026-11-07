/**
 * Browser side of a per-sentence on/off flag kept on the server (bookmarks,
 * deleted sentences): a small store over the server's data.
 *
 * Pages get the flags from the server when they render, but the back button
 * (and Next's preserved routes) can show a page again exactly as it was. So
 * every change made in this tab is kept here, applied at once (optimistically)
 * and undone if the save fails; pages read the server data through it and
 * subscribe to it. Saves go out one at a time, so a quick on → off → on can't
 * land out of order.
 */

export type SentenceFlags = {
  /**
   * Sets the flag on these sentences. Subscribers see the change at once; it is undone,
   * and this rejects with a message to show, if it couldn't be saved.
   */
  save(lessonId: string, indexes: readonly number[], on: boolean): Promise<void>;
  /** A lesson's flagged indexes from the server, updated with this tab's changes since. */
  withLocalChanges(lessonId: string, indexes: readonly number[]): Set<number>;
  /** What this tab last set a sentence to, if it changed it. */
  changedTo(lessonId: string, index: number): boolean | undefined;
  /** For useSyncExternalStore: re-render when any flag changes in this tab. */
  subscribe(onChange: () => void): () => void;
  /** Counts every change made in this tab (the store's snapshot). */
  revision(): number;
  /** Resolves once every save sent so far has finished (successfully or not). */
  settled(): Promise<void>;
};

export function sentenceFlags(
  post: (lessonId: string, indexes: number[], on: boolean) => Promise<void>,
): SentenceFlags {
  const changes = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const keyOf = (lessonId: string, index: number) => `${lessonId}:${index}`;

  const changed = () => {
    revision++;
    listeners.forEach((l) => l());
  };

  return {
    async save(lessonId, indexes, on) {
      const list = [...indexes];
      const before = list.map((i) => changes.get(keyOf(lessonId, i)));
      for (const i of list) changes.set(keyOf(lessonId, i), on);
      changed();
      const run = queue.then(() => post(lessonId, list, on));
      queue = run.catch(() => {});
      try {
        await run;
      } catch (e) {
        // Only undo what nothing newer has changed meanwhile.
        let undone = false;
        list.forEach((i, k) => {
          const key = keyOf(lessonId, i);
          if (changes.get(key) !== on) return;
          if (before[k] === undefined) changes.delete(key);
          else changes.set(key, before[k]);
          undone = true;
        });
        if (undone) changed();
        throw e;
      }
    },

    withLocalChanges(lessonId, indexes) {
      const set = new Set(indexes);
      const prefix = `${lessonId}:`;
      for (const [key, on] of changes) {
        if (!key.startsWith(prefix)) continue;
        const i = Number(key.slice(prefix.length));
        if (on) set.add(i);
        else set.delete(i);
      }
      return set;
    },

    changedTo: (lessonId, index) => changes.get(keyOf(lessonId, index)),

    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },

    revision: () => revision,

    settled: () => queue.then(() => undefined),
  };
}

/** POSTs JSON, turning failures into a message to show. */
export async function postJson(url: string, body: unknown, failMessage: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? failMessage);
}
