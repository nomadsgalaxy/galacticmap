import { Suspense } from "react";
import Link from "next/link";
import { LayoutGrid } from "lucide-react";
import { signOut } from "@/auth";
import { requireUserId } from "@/app/lib/session";
import { listBoardsForUser } from "@/app/lib/boards";
import { createBoard, deleteBoard } from "@/app/lib/board-actions";
import { isInstanceAdmin } from "@/app/lib/admin";
import { ImportBoardButton } from "@/app/_components/ImportBoardButton";

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-5xl p-6 pb-24">
      <Suspense fallback={<p className="text-sm text-on-surface-variant">Loading your boards…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

async function Dashboard() {
  const userId = await requireUserId(); // redirects to /login if not signed in
  const [boards, admin] = await Promise.all([listBoardsForUser(userId), isInstanceAdmin(userId)]);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-on-background">Galactic Map</h1>
        <div className="flex flex-wrap items-center gap-2">
          {admin && (
            <Link
              href="/admin"
              className="rounded-control border border-primary/40 bg-primary-container px-3 py-1.5 text-sm font-medium text-on-primary-container transition hover:opacity-90 active:scale-[.98]"
            >
              Admin
            </Link>
          )}
          <Link
            href="/galaxy"
            className="rounded-control border border-outline-variant px-3 py-1.5 text-sm text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98]"
          >
            Galaxy
          </Link>
          <Link
            href="/settings/tokens"
            className="rounded-control border border-outline-variant px-3 py-1.5 text-sm text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98]"
          >
            API tokens
          </Link>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button className="rounded-control border border-outline-variant px-3 py-1.5 text-sm text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98]">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <form action={createBoard} className="flex flex-1 gap-2">
          <input
            name="title"
            placeholder="New board title…"
            className="flex-1 rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
          />
          <button className="rounded-control bg-primary px-4 py-2 text-sm font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98]">
            + New board
          </button>
        </form>
        <ImportBoardButton />
      </div>

      {boards.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-panel border border-dashed border-outline-variant bg-surface-container-low p-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
            <LayoutGrid size={22} />
          </div>
          <h2 className="text-base font-semibold text-on-surface">Create your first board</h2>
          <p className="max-w-sm text-sm text-on-surface-variant">
            A board is an infinite canvas for moodboards and mind-maps. Drop in colors, images, links
            and text — link them up later, or don&apos;t. Use the field above to name your first one.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((b) => {
            const role = b.memberships[0]?.role ?? "VISITOR";
            return (
              <li
                key={b.id}
                className="group relative rounded-panel border border-outline-variant bg-surface-container p-4 transition hover:-translate-y-0.5 hover:border-primary hover:shadow-elev-2"
              >
                <Link href={`/boards/${b.id}`} className="block">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="rounded bg-secondary-container px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-on-secondary-container">
                      {role}
                    </span>
                    <span className="text-xs tabular-nums text-on-surface-variant">{b._count.nodes} items</span>
                  </div>
                  <h2 className="truncate font-medium text-on-surface">{b.title}</h2>
                  <p className="mt-1 text-xs text-on-surface-variant">
                    Updated {new Date(b.updatedAt).toLocaleDateString()}
                  </p>
                </Link>
                <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                  {(role === "OWNER" || role === "TEAM") && (
                    <a
                      href={`/api/boards/${b.id}/export`}
                      className="rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant"
                      title="Export board as JSON"
                    >
                      Export
                    </a>
                  )}
                  {role === "OWNER" && (
                    <form action={deleteBoard.bind(null, b.id)}>
                      <button
                        className="rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-error-container hover:text-on-error-container"
                        title="Delete board"
                      >
                        Delete
                      </button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
