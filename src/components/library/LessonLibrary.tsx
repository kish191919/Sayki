"use client";

import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import LessonCard, { lessonBadge } from "@/components/LessonCard";
import ConfirmDialog from "@/components/library/ConfirmDialog";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  GridIcon,
  ListIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "@/components/icons";
import { forgetLessons, parsePracticeStats, practiceSnapshot, type PracticeStat } from "@/lib/progress";
import { FOLDER_NAME_MAX, type LibraryLesson, type LibraryOp, type LibraryState } from "@/lib/types";

type Status = "all" | "new" | "doing" | "done";
type Sort = "created" | "practiced" | "title";
type View = "grid" | "list";

const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: "all", label: "모든 상태" },
  { value: "new", label: "시작 전" },
  { value: "doing", label: "연습 중" },
  { value: "done", label: "완주" },
];

const SORT_OPTIONS: { value: Sort; label: string }[] = [
  { value: "created", label: "최근 만든 순" },
  { value: "practiced", label: "최근 연습한 순" },
  { value: "title", label: "제목 순" },
];

/** Cards rendered at a time; "더 보기" adds another page. */
const PAGE = 48;

// Fixed time zone so the server render and the browser agree.
const DATE = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "2-digit",
  month: "numeric",
  day: "numeric",
});

/* ------------------------- Remembered view choices ------------------------ */

type Prefs = { sort: Sort; view: View };
const PREFS_KEY = "sayki:library";
const prefListeners = new Set<() => void>();
/** Same-tab copy, so choices still apply when storage is blocked. */
let prefsMemory: string | null = null;

function prefsSnapshot(): string | null {
  if (prefsMemory !== null) return prefsMemory;
  try {
    return window.localStorage.getItem(PREFS_KEY);
  } catch {
    return null;
  }
}

function subscribePrefs(onChange: () => void) {
  prefListeners.add(onChange);
  return () => {
    prefListeners.delete(onChange);
  };
}

function parsePrefs(raw: string | null): Prefs {
  let p: Partial<Prefs> = {};
  try {
    p = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
  } catch {
    /* ignore */
  }
  return {
    sort: SORT_OPTIONS.some((o) => o.value === p.sort) ? (p.sort as Sort) : "created",
    view: p.view === "list" ? "list" : "grid",
  };
}

function savePrefs(prefs: Prefs) {
  prefsMemory = JSON.stringify(prefs);
  try {
    window.localStorage.setItem(PREFS_KEY, prefsMemory);
  } catch {
    /* kept for this tab only */
  }
  prefListeners.forEach((l) => l());
}

function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/* --------------------------------- Helpers -------------------------------- */

const norm = (s: string) => s.normalize("NFC").toLowerCase();

function statusOf(lesson: LibraryLesson, stat: PracticeStat | undefined): Exclude<Status, "all"> {
  const n = stat?.practiced ?? 0;
  if (n === 0) return "new";
  return n >= lesson.sentenceCount ? "done" : "doing";
}

function place(placement: Record<string, string>, ids: Iterable<string>, folderId: string | null) {
  const next = { ...placement };
  for (const id of ids) {
    if (folderId) next[id] = folderId;
    else delete next[id];
  }
  return next;
}

async function send(op: LibraryOp): Promise<{ library: LibraryState; folderId?: string }> {
  let res: Response;
  try {
    res = await fetch("/api/library", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(op),
    });
  } catch {
    throw new Error("서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  const data = (await res.json().catch(() => ({}))) as {
    library?: LibraryState;
    folderId?: string;
    error?: string;
  };
  if (!res.ok || !data.library) throw new Error(data.error ?? "저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
  return { library: data.library, folderId: data.folderId };
}

/* -------------------------------- Component ------------------------------- */

type Props = { lessons: LibraryLesson[]; library: LibraryState };

/** "내 레슨": every lesson, organized into folders, searchable and sortable. */
export default function LessonLibrary({ lessons: serverLessons, library: serverLibrary }: Props) {
  // Local copy for instant edits; a navigation that brings fresh server data
  // replaces it (the page stays mounted between visits).
  const [source, setSource] = useState({ lessons: serverLessons, library: serverLibrary });
  const [lessons, setLessons] = useState(serverLessons);
  const [library, setLibrary] = useState(serverLibrary);
  if (source.lessons !== serverLessons || source.library !== serverLibrary) {
    setSource({ lessons: serverLessons, library: serverLibrary });
    setLessons(serverLessons);
    setLibrary(serverLibrary);
  }

  const { sort, view } = parsePrefs(useSyncExternalStore(subscribePrefs, prefsSnapshot, () => null));
  const practice = useSyncExternalStore(subscribeStorage, practiceSnapshot, () => "");
  const stats = useMemo(() => parsePracticeStats(practice), [practice]);

  const [folder, setFolder] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** Folder being filled from the "레슨 담기" flow. */
  const [into, setInto] = useState<string | null>(null);
  const [editing, setEditing] = useState<null | "create" | "rename">(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "deleteLessons" | "deleteFolder">(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  const folderById = useMemo(() => new Map(library.folders.map((f) => [f.id, f])), [library.folders]);
  const folderIdOf = (id: string) => {
    const f = library.placement[id];
    return f && folderById.has(f) ? f : null;
  };

  const counts = useMemo(() => {
    const byFolder = new Map<string, number>();
    let none = 0;
    for (const l of lessons) {
      const f = library.placement[l.id];
      if (f && folderById.has(f)) byFolder.set(f, (byFolder.get(f) ?? 0) + 1);
      else none++;
    }
    return { byFolder, none };
  }, [lessons, library.placement, folderById]);

  const active = folder === "all" || folder === "none" || folderById.has(folder) ? folder : "all";
  const activeFolder = folderById.get(active) ?? null;
  const intoFolder = into ? (folderById.get(into) ?? null) : null;

  const filtered = useMemo(() => {
    const words = norm(query).split(/\s+/).filter(Boolean);
    const list = lessons.filter((l) => {
      const f = library.placement[l.id];
      const inFolder = f && folderById.has(f) ? f : null;
      if (active === "none" ? inFolder !== null : active !== "all" && inFolder !== active) return false;
      if (status !== "all" && statusOf(l, stats.get(l.id)) !== status) return false;
      if (words.length > 0) {
        const title = norm(l.title);
        if (!words.every((w) => title.includes(w))) return false;
      }
      return true;
    });
    const created = (l: LibraryLesson) => Date.parse(l.createdAt) || 0;
    if (sort === "title") list.sort((a, b) => a.title.localeCompare(b.title, "ko"));
    else if (sort === "practiced") {
      list.sort((a, b) => (stats.get(b.id)?.at ?? 0) - (stats.get(a.id)?.at ?? 0) || created(b) - created(a));
    } else list.sort((a, b) => created(b) - created(a));
    return list;
  }, [lessons, library.placement, folderById, active, status, stats, query, sort]);

  const filterKey = `${active}|${query}|${status}|${sort}`;
  const [shown, setShown] = useState({ key: filterKey, count: PAGE });
  const limit = shown.key === filterKey ? shown.count : PAGE;
  const visible = filtered.slice(0, limit);
  const filtering = query.trim() !== "" || status !== "all";

  const allSelected = filtered.length > 0 && filtered.every((l) => selected.has(l.id));

  /* ------------------------------ UI transitions ----------------------------- */

  const flash = (text: string, bad = false) => {
    window.clearTimeout(noticeTimer.current);
    setNotice({ text, bad });
    noticeTimer.current = window.setTimeout(() => setNotice(null), bad ? 5000 : 3000);
  };

  const pickFolder = (id: string) => {
    setFolder(id);
    setEditing((e) => (e === "rename" ? null : e));
  };

  const startSelecting = (target: string | null) => {
    setInto(target);
    if (target) setFolder("all");
    setSelecting(true);
    setSelected(new Set());
    setEditing(null);
  };

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setInto(null);
    setMoveOpen(false);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Menus and dialogs are transient: close them when the page is hidden
  // (Next keeps it mounted in the background between visits).
  useLayoutEffect(
    () => () => {
      setMoveOpen(false);
      setConfirm(null);
      setEditing(null);
      setSelecting(false);
      setSelected(new Set());
      setInto(null);
    },
    [],
  );

  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirm) return;
      if (moveOpen) {
        setMoveOpen(false);
        return;
      }
      setSelecting(false);
      setSelected(new Set());
      setInto(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, moveOpen, confirm]);

  /* --------------------------------- Mutations -------------------------------- */

  /** Sends one op; `optimistic` is shown right away and rolled back on failure. */
  const run = async (op: LibraryOp, optimistic?: { library?: LibraryState; lessons?: LibraryLesson[] }) => {
    if (busy) return null;
    const before = { library, lessons };
    setBusy(true);
    if (optimistic?.library) setLibrary(optimistic.library);
    if (optimistic?.lessons) setLessons(optimistic.lessons);
    try {
      const res = await send(op);
      setLibrary(res.library);
      return res;
    } catch (e) {
      setLibrary(before.library);
      setLessons(before.lessons);
      flash((e as Error).message, true);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createFolder = async (name: string, moveIds: string[] = []) => {
    const res = await run({ op: "createFolder", name, lessonIds: moveIds.length > 0 ? moveIds : undefined });
    if (!res?.folderId) return false;
    const made = res.library.folders.find((f) => f.id === res.folderId);
    const label = made?.name ?? name;
    if (moveIds.length > 0) {
      flash(`${moveIds.length}개를 ‘${label}’ 폴더에 담았어요`);
      stopSelecting();
    } else {
      flash(`‘${label}’ 폴더를 만들었어요`);
    }
    setFolder(res.folderId);
    return true;
  };

  const renameFolder = async (id: string, name: string) => {
    const res = await run(
      { op: "renameFolder", id, name },
      { library: { ...library, folders: library.folders.map((f) => (f.id === id ? { ...f, name } : f)) } },
    );
    return res !== null;
  };

  const deleteFolder = async (id: string) => {
    const name = folderById.get(id)?.name ?? "";
    const res = await run(
      { op: "deleteFolder", id },
      {
        library: {
          folders: library.folders.filter((f) => f.id !== id),
          placement: Object.fromEntries(Object.entries(library.placement).filter(([, f]) => f !== id)),
        },
      },
    );
    if (!res) return;
    setFolder("all");
    flash(`‘${name}’ 폴더를 삭제했어요. 안에 있던 레슨은 미분류로 옮겼어요`);
  };

  const moveSelected = async (target: string | null) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setMoveOpen(false);
    const res = await run(
      { op: "move", lessonIds: ids, folderId: target },
      { library: { ...library, placement: place(library.placement, ids, target) } },
    );
    if (!res) return;
    const name = target ? folderById.get(target)?.name : null;
    flash(name ? `${ids.length}개를 ‘${name}’ 폴더에 담았어요` : `${ids.length}개를 폴더에서 뺐어요`);
    if (into) setFolder(into);
    stopSelecting();
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const gone = new Set(ids);
    const res = await run(
      { op: "deleteLessons", lessonIds: ids },
      {
        lessons: lessons.filter((l) => !gone.has(l.id)),
        library: { ...library, placement: place(library.placement, ids, null) },
      },
    );
    if (!res) return;
    forgetLessons(ids);
    flash(`레슨 ${ids.length}개를 삭제했어요`);
    stopSelecting();
  };

  /* ---------------------------------- Render --------------------------------- */

  const clearFilters = () => {
    setQuery("");
    setStatus("all");
  };

  let empty: ReactNode = null;
  if (visible.length === 0) {
    if (lessons.length === 0) {
      empty = (
        <Empty title="아직 만든 레슨이 없어요" text="유튜브 링크를 붙여 넣어 첫 레슨을 만들어 보세요.">
          <Link href="/#start" className={PRIMARY}>
            <PlusIcon size={16} /> 레슨 만들기
          </Link>
        </Empty>
      );
    } else if (filtering) {
      empty = (
        <Empty title="조건에 맞는 레슨이 없어요" text="검색어나 상태 필터를 바꿔 보세요.">
          <button type="button" onClick={clearFilters} className={SECONDARY}>
            필터 지우기
          </button>
        </Empty>
      );
    } else if (activeFolder) {
      empty = (
        <Empty title="이 폴더는 비어 있어요" text="다른 레슨을 골라 이 폴더에 담아 보세요.">
          <button type="button" onClick={() => startSelecting(activeFolder.id)} className={PRIMARY}>
            <PlusIcon size={16} /> 레슨 담기
          </button>
        </Empty>
      );
    } else {
      empty = <Empty title="미분류 레슨이 없어요" text="모든 레슨이 폴더에 정리되어 있어요." />;
    }
  }

  return (
    <div className={selecting ? "pb-32" : undefined}>
      {/* Title */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">내 레슨</h1>
          <p className="mt-1 text-sm text-muted">
            레슨 {lessons.length}개{library.folders.length > 0 && <> · 폴더 {library.folders.length}개</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lessons.length > 0 && (
            <button
              type="button"
              aria-pressed={selecting}
              onClick={selecting ? stopSelecting : () => startSelecting(null)}
              className={selecting ? DARK : SECONDARY}
            >
              <CheckIcon size={16} /> {selecting ? "정리 끝내기" : "정리하기"}
            </button>
          )}
          <Link href="/#start" className={PRIMARY}>
            <PlusIcon size={16} /> 새 레슨
          </Link>
        </div>
      </div>

      {lessons.length > 0 && (
        <>
          {/* Folders */}
          <div className="-mx-4 mt-6 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
            <Chip active={active === "all"} count={lessons.length} onClick={() => pickFolder("all")}>
              전체
            </Chip>
            {library.folders.length > 0 && (
              <Chip active={active === "none"} count={counts.none} onClick={() => pickFolder("none")}>
                미분류
              </Chip>
            )}
            {library.folders.map((f) => (
              <Chip key={f.id} active={active === f.id} count={counts.byFolder.get(f.id) ?? 0} onClick={() => pickFolder(f.id)}>
                <FolderIcon size={14} className="shrink-0" />
                <span className="max-w-[11rem] truncate">{f.name}</span>
              </Chip>
            ))}
            {editing === "create" ? (
              <NameInput
                placeholder="새 폴더 이름"
                submitLabel="만들기"
                busy={busy}
                onCancel={() => setEditing(null)}
                onSubmit={async (name) => {
                  if (await createFolder(name)) setEditing(null);
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditing("create")}
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full border border-dashed border-line px-3.5 text-sm font-semibold text-muted transition hover:border-accent hover:text-accent"
              >
                <PlusIcon size={14} /> 새 폴더
              </button>
            )}
          </div>

          {/* Current folder */}
          {activeFolder && (
            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
              {editing === "rename" ? (
                <NameInput
                  initial={activeFolder.name}
                  placeholder="폴더 이름"
                  submitLabel="저장"
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSubmit={async (name) => {
                    if (name === activeFolder.name || (await renameFolder(activeFolder.id, name))) setEditing(null);
                  }}
                />
              ) : (
                <>
                  <h2 className="flex min-w-0 items-center gap-2 text-lg font-bold">
                    <FolderIcon className="shrink-0 text-accent" />
                    <span className="truncate">{activeFolder.name}</span>
                  </h2>
                  <div className="flex items-center gap-0.5 text-sm">
                    <button type="button" onClick={() => startSelecting(activeFolder.id)} className={GHOST}>
                      <PlusIcon size={14} /> 레슨 담기
                    </button>
                    <button type="button" onClick={() => setEditing("rename")} className={GHOST}>
                      <PencilIcon size={14} /> 이름 바꾸기
                    </button>
                    <button type="button" onClick={() => setConfirm("deleteFolder")} className={`${GHOST} hover:text-bad`}>
                      <TrashIcon size={14} /> 폴더 삭제
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Search, filter, sort, view */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="flex h-10 min-w-0 flex-1 basis-60 items-center gap-2 rounded-xl border border-line bg-surface px-3 focus-within:border-accent">
              <SearchIcon size={16} className="shrink-0 text-muted" />
              <span className="sr-only">제목으로 찾기</span>
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
            <Select label="상태" value={status} options={STATUS_OPTIONS} onChange={setStatus} highlight={status !== "all"} />
            <Select label="정렬" value={sort} options={SORT_OPTIONS} onChange={(s) => savePrefs({ sort: s, view })} />
            <div role="group" aria-label="보기 방식" className="flex h-10 shrink-0 gap-0.5 rounded-xl border border-line bg-surface p-1">
              {(
                [
                  ["grid", "카드로 보기", <GridIcon key="g" size={16} />],
                  ["list", "목록으로 보기", <ListIcon key="l" size={16} />],
                ] as const
              ).map(([v, label, icon]) => (
                <button
                  key={v}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-pressed={view === v}
                  onClick={() => savePrefs({ sort, view: v })}
                  className={`flex w-8 items-center justify-center rounded-lg transition ${
                    view === v ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>

          {(filtering || selecting) && (
            <p className="mt-4 flex flex-wrap items-center gap-x-2 text-sm text-muted">
              {selecting ? (
                intoFolder ? (
                  <span>
                    <b className="text-ink">‘{intoFolder.name}’</b>에 담을 레슨을 눌러 고르세요.
                  </span>
                ) : (
                  <span>옮기거나 삭제할 레슨을 눌러 고르세요.</span>
                )
              ) : (
                <>
                  <span>{filtered.length}개 찾음</span>
                  <button type="button" onClick={clearFilters} className="font-semibold underline-offset-4 hover:text-ink hover:underline">
                    필터 지우기
                  </button>
                </>
              )}
            </p>
          )}
        </>
      )}

      {/* Lessons */}
      {empty ?? (
        <div
          className={
            view === "grid"
              ? "mt-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
              : "mt-5 grid grid-cols-1 gap-2 lg:grid-cols-2"
          }
        >
          {visible.map((l) => {
            const stat = stats.get(l.id);
            const f = active === "all" ? folderIdOf(l.id) : null;
            return (
              <LessonCard
                key={l.id}
                id={l.id}
                title={l.title}
                thumbnail={l.thumbnail}
                sentenceCount={l.sentenceCount}
                practiced={stat?.practiced ? stat.practiced : undefined}
                badge={lessonBadge(l)}
                folder={f ? folderById.get(f)?.name : null}
                date={DATE.format(new Date(l.createdAt))}
                layout={view === "list" ? "row" : "grid"}
                selection={selecting ? { selected: selected.has(l.id), onToggle: () => toggle(l.id) } : undefined}
              />
            );
          })}
        </div>
      )}

      {filtered.length > limit && (
        <div className="mt-6 flex justify-center">
          <button type="button" onClick={() => setShown({ key: filterKey, count: limit + PAGE })} className={SECONDARY}>
            더 보기 <span className="text-muted">({filtered.length - limit}개 남음)</span>
          </button>
        </div>
      )}

      {/* Selection bar */}
      {selecting && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <div className="relative mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-2 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.35)]">
            <p className="pl-2 text-sm font-bold tabular-nums">{selected.size}개 선택</p>
            <button
              type="button"
              onClick={() => setSelected(allSelected ? new Set() : new Set(filtered.map((l) => l.id)))}
              className={`${GHOST} text-sm`}
            >
              {allSelected ? "선택 해제" : "전체 선택"}
            </button>
            <div className="ml-auto flex items-center gap-1.5">
              {intoFolder ? (
                <button
                  type="button"
                  disabled={selected.size === 0 || busy}
                  onClick={() => void moveSelected(intoFolder.id)}
                  className={`${PRIMARY} max-w-[14rem] disabled:opacity-50`}
                >
                  <span className="truncate">‘{intoFolder.name}’에 담기</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={selected.size === 0 || busy}
                    aria-expanded={moveOpen}
                    onClick={() => setMoveOpen((o) => !o)}
                    className={`${SECONDARY} disabled:opacity-50`}
                  >
                    <FolderIcon size={16} /> 이동
                  </button>
                  <button
                    type="button"
                    disabled={selected.size === 0 || busy}
                    onClick={() => setConfirm("deleteLessons")}
                    className={`${SECONDARY} text-bad disabled:opacity-50`}
                  >
                    <TrashIcon size={16} /> 삭제
                  </button>
                </>
              )}
              <button type="button" onClick={stopSelecting} className={DARK}>
                {intoFolder ? "취소" : "완료"}
              </button>
            </div>

            {moveOpen && !intoFolder && (
              <MoveMenu
                folders={library.folders}
                busy={busy}
                onClose={() => setMoveOpen(false)}
                onPick={(id) => void moveSelected(id)}
                onCreate={(name) => createFolder(name, [...selected])}
              />
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === "deleteLessons"}
        title={`레슨 ${selected.size}개를 삭제할까요?`}
        confirmLabel="삭제"
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void deleteSelected();
        }}
      >
        문장·번역과 이 기기의 연습 기록이 함께 지워지고 되돌릴 수 없어요. 같은 링크로 언제든 다시 만들 수 있어요.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "deleteFolder" && activeFolder !== null}
        title={`‘${activeFolder?.name ?? ""}’ 폴더를 삭제할까요?`}
        confirmLabel="폴더 삭제"
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          if (activeFolder) void deleteFolder(activeFolder.id);
        }}
      >
        안에 있는 레슨 {counts.byFolder.get(activeFolder?.id ?? "") ?? 0}개는 지워지지 않고 미분류로 옮겨져요.
      </ConfirmDialog>

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-4">
        {notice && (
          <p
            className={`max-w-full break-keep rounded-full px-4 py-2 text-center text-sm font-semibold shadow-lg ${
              notice.bad ? "bg-bad text-white" : "bg-ink text-bg"
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Small pieces ------------------------------ */

const BUTTON = "inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-bold transition";
const PRIMARY = `${BUTTON} bg-accent text-on-accent hover:bg-accent-strong`;
const SECONDARY = `${BUTTON} border border-line bg-surface hover:border-muted`;
const DARK = `${BUTTON} bg-ink text-bg hover:opacity-90`;
const GHOST =
  "inline-flex h-9 items-center gap-1 rounded-full px-2.5 font-semibold text-muted transition hover:bg-surface-2 hover:text-ink";

function Chip({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition ${
        active ? "border-ink bg-ink text-bg" : "border-line bg-surface hover:border-muted"
      }`}
    >
      {children}
      <span className={`text-xs tabular-nums ${active ? "opacity-70" : "text-muted"}`}>{count}</span>
    </button>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  highlight = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  highlight?: boolean;
}) {
  return (
    <label className="relative shrink-0">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className={`h-10 appearance-none rounded-xl border bg-surface pl-3 pr-8 text-sm font-semibold outline-none focus-visible:border-accent ${
          highlight ? "border-accent text-accent" : "border-line"
        }`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
    </label>
  );
}

function NameInput({
  initial = "",
  placeholder,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = value.trim();
    if (name) void onSubmit(name);
    else onCancel();
  };
  return (
    <form onSubmit={submit} className="flex shrink-0 items-center gap-1">
      <input
        autoFocus
        value={value}
        maxLength={FOLDER_NAME_MAX}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={busy}
        className="h-9 w-44 min-w-0 rounded-full border border-accent bg-surface px-3.5 text-sm outline-none placeholder:text-muted"
      />
      <button
        type="submit"
        disabled={busy || !value.trim()}
        className="h-9 shrink-0 rounded-full bg-accent px-3.5 text-sm font-bold text-on-accent disabled:opacity-50"
      >
        {submitLabel}
      </button>
      <button
        type="button"
        aria-label="취소"
        onClick={onCancel}
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
      >
        <CloseIcon size={16} />
      </button>
    </form>
  );
}

function MoveMenu({
  folders,
  busy,
  onPick,
  onCreate,
  onClose,
}: {
  folders: LibraryState["folders"];
  busy: boolean;
  onPick: (folderId: string | null) => void;
  onCreate: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [creating, setCreating] = useState(folders.length === 0);
  const item =
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-surface-2 disabled:opacity-50";
  return (
    <>
      <button type="button" tabIndex={-1} aria-label="닫기" onClick={onClose} className="fixed inset-0 cursor-default" />
      <div className="absolute bottom-full right-0 mb-2 w-72 max-w-full rounded-xl border border-line bg-surface p-1.5 shadow-lg">
        <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-muted">어느 폴더로 옮길까요?</p>
        <div className="max-h-64 overflow-y-auto">
          {folders.map((f) => (
            <button key={f.id} type="button" disabled={busy} onClick={() => onPick(f.id)} className={item}>
              <FolderIcon size={15} className="shrink-0 text-muted" />
              <span className="truncate">{f.name}</span>
            </button>
          ))}
          {folders.length > 0 && (
            <button type="button" disabled={busy} onClick={() => onPick(null)} className={`${item} text-muted`}>
              <CloseIcon size={15} className="shrink-0" /> 폴더에서 빼기 (미분류)
            </button>
          )}
        </div>
        <div className="mt-1 border-t border-line pt-1.5">
          {creating ? (
            <div className="px-1 pb-0.5">
              <NameInput
                placeholder="새 폴더 이름"
                submitLabel="담기"
                busy={busy}
                onCancel={() => (folders.length === 0 ? onClose() : setCreating(false))}
                onSubmit={async (name) => {
                  await onCreate(name);
                }}
              />
            </div>
          ) : (
            <button type="button" onClick={() => setCreating(true)} className={`${item} text-accent`}>
              <PlusIcon size={15} className="shrink-0" /> 새 폴더 만들어 담기
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="mt-5 flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-14 text-center">
      <p className="font-bold">{title}</p>
      <p className="mt-1 break-keep text-sm text-muted">{text}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}
