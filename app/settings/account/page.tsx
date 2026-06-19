import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/app/_components/PageHeader";
import { requireUserId } from "@/app/lib/session";
import { prisma } from "@/app/lib/db";
import { DeleteAccount } from "./DeleteAccount";

export default function AccountSettingsPage() {
  return (
    <main className="mx-auto w-full max-w-2xl p-6 pb-24">
      <PageHeader back="/" backLabel="Back to dashboard" title="Account" />
      <Suspense fallback={<p className="text-sm text-on-surface-variant">Loading…</p>}>
        <DangerZone />
      </Suspense>
    </main>
  );
}

async function DangerZone() {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user?.email) redirect("/login");

  return (
    <section className="mt-2 rounded-panel border border-error/40 bg-error-container/20 p-4">
      <h2 className="text-sm font-semibold text-on-surface">Delete your account</h2>
      <p className="mb-4 mt-1 text-sm text-on-surface-variant">
        Permanently deletes your account and everything in it — every board you created, their nodes and
        connectors, and your uploaded images. This can&apos;t be undone. Export anything you want to keep
        first (each board has an Export option on the dashboard).
      </p>
      <DeleteAccount email={user.email} />
    </section>
  );
}
