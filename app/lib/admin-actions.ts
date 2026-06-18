"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/app/lib/db";
import { requireInstanceAdmin } from "@/app/lib/admin";
import { revalidateTag } from "next/cache";
import { tags } from "@/app/lib/cache-tags";

// Instance-admin moderation actions. Deliberately limited to safe, reversible-ish operations
// (unpublish a public board, revoke an API token). Destructive ops (delete user/board) are
// intentionally left out of v1 — do those deliberately via the owner UI.

export async function adminUnpublishShare(shareId: string): Promise<{ ok: true }> {
  await requireInstanceAdmin();
  const share = await prisma.publicShare.findUnique({ where: { id: shareId }, select: { boardId: true } });
  if (share) {
    await prisma.publicShare.update({ where: { id: shareId }, data: { isPublished: false } });
    revalidateTag(tags.shareByBoard(share.boardId), "max");
  }
  revalidatePath("/admin");
  return { ok: true };
}

export async function adminRevokeToken(tokenId: string): Promise<{ ok: true }> {
  await requireInstanceAdmin();
  await prisma.apiToken.deleteMany({ where: { id: tokenId } });
  revalidatePath("/admin");
  return { ok: true };
}
