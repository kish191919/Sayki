export default function RoomSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]" aria-busy="true" aria-label="연습실 불러오는 중">
      <div className="space-y-4">
        <div className="aspect-video animate-pulse rounded-2xl bg-surface-2" />
        <div className="h-44 animate-pulse rounded-2xl bg-surface-2" />
      </div>
      <div className="h-[420px] animate-pulse rounded-2xl bg-surface-2" />
    </div>
  );
}
