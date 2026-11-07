import "server-only";
import { randomBytes } from "node:crypto";
import { forgetBookmarks } from "./bookmarks";
import { LessonError } from "./errors";
import { deleteLessons, isLessonId, loadLibrary, saveLibrary } from "./store";
import { FOLDER_NAME_MAX, type LibraryState } from "./types";

const MAX_FOLDERS = 100;
const MAX_IDS = 1000;

function folderName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  if (!name) throw new LessonError("BAD_NAME", "폴더 이름을 입력해 주세요.", 400);
  if ([...name].length > FOLDER_NAME_MAX) {
    throw new LessonError("BAD_NAME", `폴더 이름은 ${FOLDER_NAME_MAX}자 이하로 지어 주세요.`, 400);
  }
  return name;
}

function assertUnique(library: LibraryState, name: string, exceptId?: string) {
  const key = name.toLowerCase();
  if (library.folders.some((f) => f.id !== exceptId && f.name.toLowerCase() === key)) {
    throw new LessonError("DUPLICATE_FOLDER", `‘${name}’ 폴더가 이미 있어요.`, 409);
  }
}

function lessonIds(raw: unknown, required: boolean): string[] {
  if (raw == null && !required) return [];
  if (!Array.isArray(raw)) throw new LessonError("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string" && isLessonId(x)))];
  if (required && ids.length === 0) throw new LessonError("NO_LESSONS", "레슨을 먼저 골라 주세요.", 400);
  if (ids.length > MAX_IDS) throw new LessonError("TOO_MANY", `한 번에 ${MAX_IDS}개까지만 옮길 수 있어요.`, 400);
  return ids;
}

function existingFolder(library: LibraryState, raw: unknown) {
  const folder = typeof raw === "string" ? library.folders.find((f) => f.id === raw) : undefined;
  if (!folder) throw new LessonError("NO_FOLDER", "폴더를 찾지 못했어요. 페이지를 새로고침해 주세요.", 404);
  return folder;
}

function place(placement: Record<string, string>, ids: string[], folderId: string | null) {
  const next = { ...placement };
  for (const id of ids) {
    if (folderId) next[id] = folderId;
    else delete next[id];
  }
  return next;
}

/**
 * Applies one organizing action and returns the saved state. The client
 * sends intents, not whole documents, so a stale tab can't erase folders.
 */
export async function applyLibraryOp(body: unknown): Promise<{ library: LibraryState; folderId?: string }> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const library = await loadLibrary();
  let next: LibraryState;
  let folderId: string | undefined;

  switch (input.op) {
    case "createFolder": {
      const name = folderName(input.name);
      assertUnique(library, name);
      if (library.folders.length >= MAX_FOLDERS) {
        throw new LessonError("TOO_MANY_FOLDERS", `폴더는 ${MAX_FOLDERS}개까지 만들 수 있어요.`, 400);
      }
      folderId = `f_${randomBytes(6).toString("base64url")}`;
      next = {
        folders: [...library.folders, { id: folderId, name }],
        placement: place(library.placement, lessonIds(input.lessonIds, false), folderId),
      };
      break;
    }
    case "renameFolder": {
      const folder = existingFolder(library, input.id);
      const name = folderName(input.name);
      assertUnique(library, name, folder.id);
      next = { ...library, folders: library.folders.map((f) => (f.id === folder.id ? { ...f, name } : f)) };
      break;
    }
    case "deleteFolder": {
      const folder = existingFolder(library, input.id);
      next = {
        folders: library.folders.filter((f) => f.id !== folder.id),
        // Its lessons go back to "미분류"; the lessons themselves stay.
        placement: Object.fromEntries(Object.entries(library.placement).filter(([, f]) => f !== folder.id)),
      };
      break;
    }
    case "move": {
      const target = input.folderId == null ? null : existingFolder(library, input.folderId).id;
      next = { ...library, placement: place(library.placement, lessonIds(input.lessonIds, true), target) };
      break;
    }
    case "deleteLessons": {
      const ids = lessonIds(input.lessonIds, true);
      await deleteLessons(ids);
      await forgetBookmarks(ids);
      next = { ...library, placement: place(library.placement, ids, null) };
      break;
    }
    default:
      throw new LessonError("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  }

  await saveLibrary(next);
  return { library: next, folderId };
}
