import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getLiveShare } from "@/app/lib/public-db";
import { PublicCanvas } from "../../p/[secret]/PublicCanvas";

// Embeddable, read-only board view (for <iframe>). Same public-safe graph + live updates as /p/[secret],
// but in embed mode: no suggestion/voting UI and trimmed chrome. Viewers can pan/zoom and read; they
// cannot recommend additions. Meant to be framed anywhere, so it intentionally has no header chip.
export default function EmbedPage({ params }: { params: Promise<{ secret: string }> }) {
  return (
    <main className="h-[100dvh] w-full">
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center text-sm text-on-surface-variant">Loading…</div>
        }
      >
        <Loader params={params} />
      </Suspense>
    </main>
  );
}

async function Loader({ params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const share = await getLiveShare(secret);
  if (!share) notFound();
  return <PublicCanvas secret={secret} snapshot={share} embed />;
}
