import type { ReactNode } from "react";
import { ChevronDownIcon } from "@/components/icons";

/** A hint that starts folded behind a small toggle. Native <details>, so it works without client JS. */
export default function MoreInfo({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={`group ${className}`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-sm font-semibold text-muted transition hover:text-accent [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronDownIcon size={16} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}
