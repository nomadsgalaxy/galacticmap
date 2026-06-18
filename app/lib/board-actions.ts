"use server";

import { redirect } from "next/navigation";
import { revalidatePath, updateTag } from "next/cache";
import { prisma } from "@/app/lib/db";
import { getPrincipal, requireUserId } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { tags } from "@/app/lib/cache-tags";

// Create a board + the creator's OWNER membership in one transaction (the seed invariant).
export async function createBoard(formData?: FormData) {
  const userId = await requireUserId();
  const title = (formData?.get("title")?.toString().trim() || "Untitled board").slice(0, 200);
  const board = await prisma.$transaction(async (tx) => {
    const b = await tx.board.create({ data: { title, userId } });
    await tx.boardMembership.create({ data: { userId, boardId: b.id, role: "OWNER" } });
    return b;
  });
  redirect(`/boards/${board.id}`);
}

export async function renameBoard(boardId: string, title: string) {
  const principal = await getPrincipal();
  await assertCan(principal, boardId, "node:edit");
  await prisma.board.update({ where: { id: boardId }, data: { title: title.slice(0, 200) } });
  updateTag(tags.boardMeta(boardId));
  revalidatePath("/");
}

export async function deleteBoard(boardId: string) {
  const principal = await getPrincipal();
  await assertCan(principal, boardId, "board:delete");
  await prisma.board.delete({ where: { id: boardId } });
  revalidatePath("/");
}
