"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/app/lib/db";
import { requireUserId } from "@/app/lib/session";
import { getStorage } from "@/app/lib/storage/driver";
import { signOut } from "@/auth";

export type DeleteState = { error?: string } | undefined;

// Permanently delete the signed-in user and everything that cascades from them: boards they created
// (+ nodes, edges, groups, public shares, suggestions, versions), their uploaded assets, memberships,
// invitations, and cross-board links. Type-to-confirm (email) is re-checked here, not just in the UI.
export async function deleteAccount(_prev: DeleteState, formData: FormData): Promise<DeleteState> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) redirect("/login");

  const confirm = String(formData.get("confirm") ?? "").trim().toLowerCase();
  if (!user.email || confirm !== user.email.toLowerCase()) {
    return { error: "Type your email address exactly to confirm." };
  }

  // Delete the stored image files first — the DB rows cascade with the user, but the files on disk don't.
  const assets = await prisma.asset.findMany({ where: { userId }, select: { storageKey: true } });
  const storage = getStorage();
  await Promise.allSettled(assets.map((a) => (a.storageKey ? storage.delete(a.storageKey) : Promise.resolve())));

  await prisma.user.delete({ where: { id: userId } }); // cascades the rest

  await signOut({ redirectTo: "/login?deleted=1" });
}
