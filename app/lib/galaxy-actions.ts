"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/app/lib/db";
import { getPrincipal } from "@/app/lib/session";
import { authorize } from "@/app/lib/authz";

// Cross-board galaxy mutations (#11). A link is creatable only between two boards the principal
// can view; deletion requires the principal to be able to view the source board.

async function canView(userId: string, boardId: string): Promise<boolean> {
  const res = await authorize({ userId }, boardId, "board:view");
  return res.ok;
}

export async function createCrossBoardLink(
  sourceBoardId: string,
  targetBoardId: string,
  label?: string | null,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const principal = await getPrincipal();
  if (!principal) return { ok: false, reason: "unauthorized" };
  if (sourceBoardId === targetBoardId) return { ok: false, reason: "A board can't link to itself." };
  const [okS, okT] = await Promise.all([
    canView(principal.userId, sourceBoardId),
    canView(principal.userId, targetBoardId),
  ]);
  if (!okS || !okT) return { ok: false, reason: "You must be a member of both boards." };

  // De-dupe an identical hyperlane (either direction).
  const existing = await prisma.crossBoardLink.findFirst({
    where: {
      OR: [
        { sourceBoardId, targetBoardId },
        { sourceBoardId: targetBoardId, targetBoardId: sourceBoardId },
      ],
    },
    select: { id: true },
  });
  if (existing) return { ok: true, id: existing.id };

  const created = await prisma.crossBoardLink.create({
    data: {
      sourceBoardId,
      targetBoardId,
      label: label?.slice(0, 120) || null,
      createdBy: principal.userId,
    },
    select: { id: true },
  });
  revalidatePath("/galaxy");
  return { ok: true, id: created.id };
}

export async function deleteCrossBoardLink(linkId: string): Promise<{ ok: true }> {
  const principal = await getPrincipal();
  if (!principal) return { ok: true };
  const link = await prisma.crossBoardLink.findUnique({
    where: { id: linkId },
    select: { sourceBoardId: true },
  });
  // Only someone who can view the source board may remove the hyperlane.
  if (link && (await canView(principal.userId, link.sourceBoardId))) {
    await prisma.crossBoardLink.delete({ where: { id: linkId } });
    revalidatePath("/galaxy");
  }
  return { ok: true };
}
