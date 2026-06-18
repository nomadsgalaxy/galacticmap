import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getPrincipal } from "@/app/lib/session";
import { prisma } from "@/app/lib/db";
import { acceptInvitation } from "@/app/lib/member-actions";

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-4 p-8 text-center">
      <Suspense fallback={<p className="text-sm text-on-surface-variant">Loading invitation…</p>}>
        <InviteLoader params={params} />
      </Suspense>
    </main>
  );
}

async function InviteLoader({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const principal = await getPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent("/invite/" + token)}`);

  const [invite, user] = await Promise.all([
    prisma.invitation.findUnique({
      where: { token },
      select: { email: true, role: true, expiresAt: true, acceptedAt: true, board: { select: { title: true } } },
    }),
    prisma.user.findUnique({ where: { id: principal.userId }, select: { email: true } }),
  ]);

  if (!invite) return <Message>Invitation not found.</Message>;
  if (invite.acceptedAt) return <Message>This invitation has already been used.</Message>;
  if (invite.expiresAt.getTime() < Date.now()) return <Message>This invitation has expired.</Message>;
  if ((user?.email ?? "").toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Message>
        This invitation is for <b>{invite.email}</b>, but you’re signed in as{" "}
        <b>{user?.email}</b>.
      </Message>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-on-background">You’re invited</h1>
      <p className="mt-2 text-on-surface-variant">
        Join <b>{invite.board.title}</b> as <b>{invite.role.toLowerCase()}</b>.
      </p>
      <form
        action={async () => {
          "use server";
          await acceptInvitation(token);
        }}
        className="mt-4"
      >
        <button className="rounded-control bg-primary px-5 py-2.5 font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98]">
          Accept invitation
        </button>
      </form>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <p className="text-on-surface">{children}</p>
      <Link href="/" className="mt-4 inline-block text-sm text-primary hover:underline">
        Go to your boards
      </Link>
    </div>
  );
}
