"use client";

import dynamic from "next/dynamic";

// Keeps its draft in localStorage and works on photos in the browser: client only.
const ScriptMaker = dynamic(() => import("./ScriptMaker"), {
  ssr: false,
  loading: () => (
    <div className="space-y-5" aria-hidden="true">
      <div className="h-44 animate-pulse rounded-2xl bg-surface-2" />
      <div className="h-56 animate-pulse rounded-2xl bg-surface-2" />
      <div className="h-12 animate-pulse rounded-full bg-surface-2" />
    </div>
  ),
});

export default function ScriptMakerLoader() {
  return <ScriptMaker />;
}
