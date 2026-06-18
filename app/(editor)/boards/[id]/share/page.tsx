import { Suspense } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/app/_components/PageHeader";
import { requireUserId } from "@/app/lib/session";
import { getBoardMeta, getShareStatus, getUserRole } from "@/app/lib/boards";
import {
  acceptSuggestion,
  listSuggestions,
  publishShare,
  rejectSuggestion,
  setSuggestionsOpen,
  unpublishShare,
} from "@/app/lib/share-actions";
import { CopyField } from "@/app/_components/CopyField";

export default function SharePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto w-full max-w-2xl p-6 pb-24">
      <Suspense fallback={<p className="text-sm text-on-surface-variant">Loading…</p>}>
        <Share params={params} />
      </Suspense>
    </main>
  );
}

async function Share({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  const role = await getUserRole(userId, id);
  if (role !== "OWNER" && role !== "TEAM") notFound();

  const [meta, share, suggestions] = await Promise.all([
    getBoardMeta(id),
    getShareStatus(id),
    listSuggestions(id),
  ]);
  const published = !!share?.isPublished;

  return (
    <>
      <PageHeader back={`/boards/${id}`} backLabel="Back to board" title={`Share · ${meta?.title}`} />

      <section className="mb-6 rounded-panel border border-outline-variant bg-surface-container p-4">
        <h2 className="mb-1 text-sm font-semibold">Public board</h2>
        <p className="mb-3 text-xs text-on-surface-variant">
          Publishes a live, read-only view (text, swatches, links — no hidden notes) that updates as
          you edit. Visitors&apos; suggestions appear on your board in real time as hazy ghosts — hover or
          click one to accept or discard it. They never change the board until you adopt them. This list
          is a bulk fallback: accept or reject a whole submission at once.
        </p>
        {published && share ? (
          <div className="space-y-3">
            <CopyField path={`/p/${share.secret}`} />
            <p className="text-xs text-on-surface-variant">Live — visitors see your edits update in real time.</p>
            <div className="flex flex-wrap items-center gap-2">
              <form action={async () => { "use server"; await setSuggestionsOpen(id, !share.suggestionsOpen); }}>
                <button className="rounded-control border border-outline-variant px-3 py-1.5 text-sm text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98]">
                  {share.suggestionsOpen ? "Close suggestions" : "Open suggestions"}
                </button>
              </form>
              <form action={async () => { "use server"; await unpublishShare(id); }}>
                <button className="rounded-control px-3 py-1.5 text-sm text-error transition hover:bg-error-container hover:text-on-error-container active:scale-[.98]">Unpublish</button>
              </form>
            </div>
            <p className="text-xs text-on-surface-variant">
              Suggestions: {share.suggestionsOpen ? "open" : "closed"}.
            </p>
          </div>
        ) : (
          <form action={async () => { "use server"; await publishShare(id); }}>
            <button className="rounded-control bg-primary px-4 py-2 text-sm font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98]">Publish public board</button>
          </form>
        )}
      </section>

      <h2 className="mb-2 text-sm font-semibold text-on-surface-variant">
        Pending suggestions ({suggestions.length})
      </h2>
      {suggestions.length === 0 ? (
        <p className="rounded-panel border border-dashed border-outline-variant bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
          No pending suggestions.
        </p>
      ) : (
        <ul className="space-y-2">
          {suggestions.map((s) => {
            const p = s.payload as {
              nodes?: Array<{ type?: string; data?: { text?: string; hex?: string; url?: string } }>;
              edges?: Array<unknown>;
            };
            const pnodes = p.nodes ?? [];
            const pedges = p.edges ?? [];
            const describe = (n: { type?: string; data?: { text?: string; hex?: string; url?: string } }) =>
              n.type === "swatch" ? `swatch ${n.data?.hex ?? ""}` : n.type === "link" ? (n.data?.url ?? "link") : (n.data?.text ?? "text");
            const summary = `${pnodes.length} item${pnodes.length === 1 ? "" : "s"}${pedges.length ? ` · ${pedges.length} connector${pedges.length === 1 ? "" : "s"}` : ""}`;
            return (
              <li key={s.id} className="flex items-start gap-2 rounded-panel border border-outline-variant bg-surface-container p-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-xs font-medium text-on-surface-variant">{summary}</div>
                  <ul className="space-y-0.5">
                    {pnodes.slice(0, 5).map((n, i) => (
                      <li key={i} className="flex items-center gap-1.5 truncate text-sm text-on-surface">
                        {n.type === "swatch" && (
                          <span className="inline-block h-3 w-3 shrink-0 rounded-sm border border-outline-variant" style={{ background: n.data?.hex ?? "#888" }} />
                        )}
                        <span className="truncate">{describe(n)}</span>
                      </li>
                    ))}
                    {pnodes.length > 5 && <li className="text-xs text-on-surface-variant">+{pnodes.length - 5} more…</li>}
                  </ul>
                  <div className="mt-1 text-xs text-on-surface-variant">
                    — {s.authorName ?? "anonymous"} · {new Date(s.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <form action={async () => { "use server"; await acceptSuggestion(s.id); }}>
                  <button className="rounded-control bg-primary px-2.5 py-1 text-xs font-medium text-on-primary transition hover:opacity-90 active:scale-[.98]" title="Add these to the board with credit">Accept</button>
                </form>
                <form action={async () => { "use server"; await rejectSuggestion(s.id); }}>
                  <button className="rounded-control px-2.5 py-1 text-xs text-on-surface-variant transition hover:bg-surface-variant active:scale-[.98]">Reject</button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
