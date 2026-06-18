import { Suspense } from "react";
import Link from "next/link";
import { PageHeader } from "@/app/_components/PageHeader";
import { requireInstanceAdmin, getAdminOverview } from "@/app/lib/admin";
import { adminUnpublishShare } from "@/app/lib/admin-actions";

export default function AdminPage() {
  return (
    <main className="mx-auto w-full max-w-5xl p-6 pb-24">
      <PageHeader back="/" backLabel="Back to dashboard" title="Instance admin" />
      <Suspense fallback={<p className="text-sm text-on-surface-variant">Loading…</p>}>
        <Admin />
      </Suspense>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-panel border border-outline-variant bg-surface-container p-3">
      <div className="text-2xl font-bold tabular-nums text-on-surface">{value}</div>
      <div className="text-xs text-on-surface-variant">{label}</div>
    </div>
  );
}

async function Admin() {
  await requireInstanceAdmin(); // 404 to non-admins
  const { stats, users, boards, shares } = await getAdminOverview();

  return (
    <div className="space-y-8">
      <section>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="Users" value={stats.users} />
          <Stat label="Boards" value={stats.boards} />
          <Stat label="Nodes" value={stats.nodes} />
          <Stat label="Edges" value={stats.edges} />
          <Stat label="Assets" value={stats.assets} />
          <Stat label="Published" value={stats.publishedShares} />
          <Stat label="API tokens" value={stats.tokens} />
          <Stat label="Cross-links" value={stats.crossLinks} />
          <Stat label="Versions" value={stats.versions} />
          <Stat label="Groups" value={stats.groups} />
          <Stat label="Pending sugg." value={stats.pendingSuggestions} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-on-surface-variant">Public boards ({shares.length})</h2>
        {shares.length === 0 ? (
          <p className="rounded-panel border border-dashed border-outline-variant bg-surface-container-low p-4 text-center text-sm text-on-surface-variant">No published boards.</p>
        ) : (
          <ul className="space-y-2">
            {shares.map((s) => (
              <li key={s.id} className="flex items-center gap-3 rounded-panel border border-outline-variant bg-surface-container p-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/p/${s.secret}`} className="truncate text-sm font-medium text-on-surface hover:text-primary">{s.boardTitle}</Link>
                  <div className="mt-0.5 text-xs tabular-nums text-on-surface-variant">
                    {s.suggestions} suggestions · suggestions {s.suggestionsOpen ? "open" : "closed"}
                  </div>
                </div>
                <form action={async () => { "use server"; await adminUnpublishShare(s.id); }}>
                  <button className="rounded-control px-3 py-1.5 text-xs text-error transition hover:bg-error-container hover:text-on-error-container active:scale-[.98]">
                    Unpublish
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-on-surface-variant">Users ({users.length})</h2>
        <div className="overflow-x-auto rounded-panel border border-outline-variant">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-container text-xs uppercase tracking-wide text-on-surface-variant">
              <tr>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2 text-right">Boards</th>
                <th className="px-3 py-2 text-right">Memberships</th>
                <th className="px-3 py-2 text-right">Tokens</th>
                <th className="px-3 py-2">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-outline-variant">
                  <td className="px-3 py-2 text-on-surface">{u.email}{u.name ? ` (${u.name})` : ""}</td>
                  <td className="px-3 py-2">
                    {u.isInstanceAdmin ? (
                      <span className="rounded bg-primary-container px-1.5 py-0.5 text-[10px] font-medium text-on-primary-container">ADMIN</span>
                    ) : (
                      <span className="text-xs text-on-surface-variant">user</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-variant">{u.boards}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-variant">{u.memberships}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-variant">{u.tokens}</td>
                  <td className="px-3 py-2 text-xs text-on-surface-variant">{new Date(u.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-on-surface-variant">Boards ({boards.length})</h2>
        <div className="overflow-x-auto rounded-panel border border-outline-variant">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-container text-xs uppercase tracking-wide text-on-surface-variant">
              <tr>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2 text-right">Nodes</th>
                <th className="px-3 py-2 text-right">Edges</th>
                <th className="px-3 py-2 text-right">Members</th>
                <th className="px-3 py-2">Public</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {boards.map((b) => (
                <tr key={b.id} className="border-t border-outline-variant">
                  <td className="px-3 py-2 text-on-surface">
                    <Link href={`/boards/${b.id}`} className="hover:text-primary">{b.title}</Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-on-surface-variant">{b.owner}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-variant">{b.nodes}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-variant">{b.edges}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-variant">{b.members}</td>
                  <td className="px-3 py-2">{b.published ? <span className="text-xs text-primary">●</span> : <span className="text-xs text-on-surface-variant">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-on-surface-variant">{new Date(b.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
