import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/app/_components/PageHeader";
import { requireUserId } from "@/app/lib/session";
import { getBoardMeta, getUserRole } from "@/app/lib/boards";
import { deleteVersion, listVersions, restoreVersion, saveVersion } from "@/app/lib/version-actions";

export default function HistoryPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto w-full max-w-2xl p-6 pb-24">
      <Suspense fallback={<p className="text-sm text-on-surface-variant">Loading…</p>}>
        <History params={params} />
      </Suspense>
    </main>
  );
}

async function History({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  const role = await getUserRole(userId, id);
  if (role !== "OWNER" && role !== "TEAM") notFound();

  const [meta, versions] = await Promise.all([getBoardMeta(id), listVersions(id)]);

  return (
    <>
      <PageHeader back={`/boards/${id}`} backLabel="Back to board" title={`Version history · ${meta?.title}`} />

      <section className="mb-6 rounded-panel border border-outline-variant bg-surface-container p-4">
        <h2 className="mb-1 text-sm font-semibold text-on-surface">Save a version</h2>
        <p className="mb-3 text-xs text-on-surface-variant">
          Snapshots the whole board (nodes, links, positions). Restoring replaces the current board
          with the snapshot — so save one first if you want to keep the present state.
        </p>
        <form
          action={async (fd: FormData) => {
            "use server";
            await saveVersion(id, fd.get("label")?.toString() || undefined);
          }}
          className="flex gap-2"
        >
          <input
            name="label"
            placeholder="Version name (optional, e.g. 'before redesign')"
            maxLength={120}
            className="flex-1 rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
          />
          <button className="rounded-control bg-primary px-4 py-2 text-sm font-medium text-on-primary transition hover:opacity-90 active:scale-[.98]">
            Save version
          </button>
        </form>
      </section>

      <h2 className="mb-2 text-sm font-semibold text-on-surface-variant">Saved versions ({versions.length})</h2>
      {versions.length === 0 ? (
        <p className="rounded-panel border border-dashed border-outline-variant bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
          No versions yet. Save one above before a big change.
        </p>
      ) : (
        <ul className="space-y-2">
          {versions.map((v) => (
            <li key={v.id} className="flex items-center gap-3 rounded-panel border border-outline-variant bg-surface-container p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-on-surface">
                  {v.label ?? `Snapshot · ${new Date(v.createdAt).toLocaleString()}`}
                </div>
                <div className="mt-0.5 text-xs tabular-nums text-on-surface-variant">
                  {v.nodeCount} nodes · {v.edgeCount} links · {new Date(v.createdAt).toLocaleString()}
                </div>
              </div>
              <form
                action={async () => {
                  "use server";
                  await restoreVersion(id, v.id);
                  redirect(`/boards/${id}`);
                }}
              >
                <button className="rounded-control bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition hover:opacity-90 active:scale-[.98]">
                  Restore
                </button>
              </form>
              <form
                action={async () => {
                  "use server";
                  await deleteVersion(id, v.id);
                }}
              >
                <button className="rounded-control px-2.5 py-1.5 text-xs text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container active:scale-[.98]">
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
