import { Suspense } from "react";
import { getPrincipal, requireUserId } from "@/app/lib/session";
import { listGalaxy } from "@/app/lib/galaxy";
import { GalaxyCanvas } from "./GalaxyCanvas";

// Cross-board galaxy view (#11). Dynamic + per-principal → loaded inside <Suspense>.
export default function GalaxyPage() {
  return (
    <main className="h-[100dvh] w-full">
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center text-sm text-on-surface-variant">
            Charting your galaxy…
          </div>
        }
      >
        <Loader />
      </Suspense>
    </main>
  );
}

async function Loader() {
  await requireUserId(); // redirect to /login if anonymous
  const { boards, links } = await listGalaxy(await getPrincipal());
  return <GalaxyCanvas boards={boards} links={links} />;
}
