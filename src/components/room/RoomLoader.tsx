"use client";

import dynamic from "next/dynamic";
import type { Lesson, RoomBookmarks } from "@/lib/types";
import RoomSkeleton from "./RoomSkeleton";

// The practice room depends on browser-only APIs (microphone, speech
// recognition, localStorage), so it renders on the client only.
const ShadowingRoom = dynamic(() => import("./ShadowingRoom"), {
  ssr: false,
  loading: () => <RoomSkeleton />,
});

type Props = {
  lesson: Lesson;
  canTranslate: boolean;
  bookmarks: RoomBookmarks;
  /** Sentence to open at instead of where practice last stopped. */
  startAt: number | null;
};

export default function RoomLoader(props: Props) {
  return <ShadowingRoom {...props} />;
}
