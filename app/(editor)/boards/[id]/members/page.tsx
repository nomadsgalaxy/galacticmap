import { Suspense } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/app/_components/PageHeader";
import { requireUserId } from "@/app/lib/session";
import { getBoardMeta, getUserRole, listInvitations, listMembers } from "@/app/lib/boards";
import {
  changeMemberRole,
  removeMember,
  revokeInvitation,
  transferOwnership,
} from "@/app/lib/member-actions";
import { InviteForm } from "@/app/_components/InviteForm";

export default function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto w-full max-w-2xl p-6 pb-24">
      <Suspense fallback={<p className="text-sm text-on-surface-variant">Loading members…</p>}>
        <Members params={params} />
      </Suspense>
    </main>
  );
}

async function Members({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  const role = await getUserRole(userId, id);
  if (role !== "OWNER") notFound(); // only owners manage members

  const [meta, members, invites] = await Promise.all([
    getBoardMeta(id),
    listMembers(id),
    listInvitations(id),
  ]);

  return (
    <>
      <PageHeader back={`/boards/${id}`} backLabel="Back to board" title={`Members · ${meta?.title}`} />

      <div className="mb-6">
        <InviteForm boardId={id} />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-on-surface-variant">Members</h2>
      <ul className="mb-6 divide-y divide-outline-variant rounded-panel border border-outline-variant">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-2 p-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-on-surface">{m.user.name ?? m.user.email}</div>
              <div className="truncate text-xs text-on-surface-variant">{m.user.email}</div>
            </div>
            <form
              action={async (fd: FormData) => {
                "use server";
                await changeMemberRole(id, m.userId, String(fd.get("role")));
              }}
              className="flex items-center gap-1"
            >
              <select
                name="role"
                defaultValue={m.role}
                className="rounded-control border border-outline-variant bg-surface px-2 py-1 text-xs text-on-surface outline-none focus-visible:border-primary"
              >
                <option value="OWNER">Owner</option>
                <option value="TEAM">Team</option>
                <option value="VISITOR">Visitor</option>
              </select>
              <button className="rounded px-2 py-1 text-xs font-medium text-primary transition hover:bg-surface-variant">Update</button>
            </form>
            {m.userId !== userId && (
              <form
                action={async () => {
                  "use server";
                  await transferOwnership(id, m.userId);
                }}
              >
                <button className="rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant">
                  Make owner
                </button>
              </form>
            )}
            <form
              action={async () => {
                "use server";
                await removeMember(id, m.userId);
              }}
            >
              <button className="rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-error-container hover:text-on-error-container">
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>

      {invites.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold text-on-surface-variant">Pending invites</h2>
          <ul className="divide-y divide-outline-variant rounded-panel border border-outline-variant">
            {invites.map((inv) => (
              <li key={inv.email} className="flex items-center gap-2 p-3">
                <span className="flex-1 truncate text-sm text-on-surface">{inv.email}</span>
                <span className="rounded bg-secondary-container px-1.5 py-0.5 text-[10px] uppercase text-on-secondary-container">
                  {inv.role}
                </span>
                <form
                  action={async () => {
                    "use server";
                    await revokeInvitation(id, inv.email);
                  }}
                >
                  <button className="rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
