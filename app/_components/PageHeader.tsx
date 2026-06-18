import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// Back-arrow + title row shared by the secondary pages (admin, tokens, members, share, history).
export function PageHeader({ back, backLabel = "Back", title }: { back: string; backLabel?: string; title: ReactNode }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <Link
        href={back}
        aria-label={backLabel}
        className="flex h-8 w-8 items-center justify-center rounded-control text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface"
      >
        <ArrowLeft size={18} />
      </Link>
      <h1 className="text-xl font-bold text-on-background">{title}</h1>
    </div>
  );
}
