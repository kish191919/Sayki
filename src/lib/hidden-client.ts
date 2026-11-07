/**
 * Browser side of deleted sentences: changes made in this tab, applied at once and
 * kept across back/forward navigation (see `sentence-flags-client`).
 */

import { postJson, sentenceFlags } from "./sentence-flags-client";

const hidden = sentenceFlags((lessonId, indexes, on) =>
  postJson(
    `/api/lessons/${lessonId}/hidden`,
    { indexes, hidden: on },
    on ? "문장을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요." : "문장을 되돌리지 못했어요. 잠시 후 다시 시도해 주세요.",
  ),
);

/** Deletes sentences from a lesson's practice (`on`), or restores them. */
export const saveHidden = hidden.save;

/** A lesson's deleted sentences from the server, updated with this tab's changes since. */
export const hiddenWithLocalChanges = hidden.withLocalChanges;

/** Whether a sentence the server didn't list as deleted still isn't, after this tab's changes. */
export const stillShown = (lessonId: string, index: number) => hidden.changedTo(lessonId, index) !== true;

/** For useSyncExternalStore: re-render when a sentence is deleted or restored in this tab. */
export const subscribeHidden = hidden.subscribe;

export const hiddenRevision = hidden.revision;
