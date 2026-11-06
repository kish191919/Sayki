"use client";

import dynamic from "next/dynamic";
import type { Lesson } from "@/lib/types";
import RoomSkeleton from "./RoomSkeleton";

// The practice room depends on browser-only APIs (microphone, speech
// recognition, localStorage), so it renders on the client only.
const ShadowingRoom = dynamic(() => import("./ShadowingRoom"), {
  ssr: false,
  loading: () => <RoomSkeleton />,
});

export default function RoomLoader({ lesson, canTranslate }: { lesson: Lesson; canTranslate: boolean }) {
  return <ShadowingRoom lesson={lesson} canTranslate={canTranslate} />;
}
