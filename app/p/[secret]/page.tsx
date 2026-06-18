import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getLiveShare } from "@/app/lib/public-db";
import { PublicCanvas } from "./PublicCanvas";

// Public, unauthenticated, read-only view (anti-grief: read-only + suggest-only). The board's
// current public-safe graph; the canvas then polls for live updates.
export default function PublicSharePage({ params }: { params: Promise<{ secret: string }> }) {
  return (
    <main className="h-[100dvh] w-full">
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center text-sm text-on-surface-variant">
            Loading…
          </div>
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
  return <PublicCanvas secret={secret} snapshot={share} />;
}
