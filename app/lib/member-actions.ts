"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/app/lib/db";
import { getPrincipal, requireUserId } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { ROLES, type Role } from "@/app/lib/types";

const INVITABLE: Role[] = ["TEAM", "VISITOR"]; // never OWNER via invite
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

async function ownerCount(boardId: string, tx = prisma) {
  return tx.boardMembership.count({ where: { boardId, role: "OWNER" } });
}

/** Create (or refresh) an invite for an email; returns the single-use link path. */
export async function inviteMember(
  boardId: string,
  email: string,
  role: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  await assertCan(await getPrincipal(), boardId, "member:manage");
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return { ok: false, error: "Invalid email" };
  const r = (INVITABLE.includes(role as Role) ? role : "VISITOR") as Role;
  const token = randomBytes(32).toString("base64url");
  const inviter = await requireUserId();
  await prisma.invitation.upsert({
    where: { boardId_email: { boardId, email: cleanEmail } },
    create: {
      boardId,
      email: cleanEmail,
      role: r,
      token,
      invitedBy: inviter,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
    update: { role: r, token, invitedBy: inviter, acceptedAt: null, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });
  revalidatePath(`/boards/${boardId}/members`);
  return { ok: true, path: `/invite/${token}` };
}

export async function revokeInvitation(boardId: string, email: string) {
  await assertCan(await getPrincipal(), boardId, "member:manage");
  await prisma.invitation.deleteMany({ where: { boardId, email } });
  revalidatePath(`/boards/${boardId}/members`);
}

/** Accept an invite: must be signed in AS the invited email; single-use; never grants OWNER. */
export async function acceptInvitation(token: string): Promise<void> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  const invite = await prisma.invitation.findUnique({ where: { token } });
  if (!invite) throw new Error("Invitation not found");
  if (invite.acceptedAt) throw new Error("Invitation already used");
  if (invite.expiresAt.getTime() < Date.now()) throw new Error("Invitation expired");
  if ((user?.email ?? "").toLowerCase() !== invite.email.toLowerCase()) {
    throw new Error("This invitation is for a different email");
  }
  const role = (INVITABLE.includes(invite.role as Role) ? invite.role : "VISITOR") as Role;
  await prisma.$transaction(async (tx) => {
    // Single-use: only consume if still unaccepted.
    const consumed = await tx.invitation.updateMany({
      where: { id: invite.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (consumed.count === 0) throw new Error("Invitation already used");
    await tx.boardMembership.upsert({
      where: { userId_boardId: { userId, boardId: invite.boardId } },
      create: { userId, boardId: invite.boardId, role, invitedBy: invite.invitedBy },
      update: {}, // already a member: keep existing role
    });
  });
  redirect(`/boards/${invite.boardId}`);
}

export async function changeMemberRole(boardId: string, userId: string, role: string) {
  await assertCan(await getPrincipal(), boardId, "member:manage");
  if (!ROLES.includes(role as Role)) return;
  const current = await prisma.boardMembership.findUnique({
    where: { userId_boardId: { userId, boardId } },
    select: { role: true },
  });
  if (!current) return;
  if (current.role === "OWNER" && role !== "OWNER" && (await ownerCount(boardId)) <= 1) {
    throw new Error("Cannot demote the last owner");
  }
  await prisma.boardMembership.update({
    where: { userId_boardId: { userId, boardId } },
    data: { role: role as Role },
  });
  revalidatePath(`/boards/${boardId}/members`);
}

export async function removeMember(boardId: string, userId: string) {
  await assertCan(await getPrincipal(), boardId, "member:manage");
  const m = await prisma.boardMembership.findUnique({
    where: { userId_boardId: { userId, boardId } },
    select: { role: true },
  });
  if (!m) return;
  if (m.role === "OWNER" && (await ownerCount(boardId)) <= 1) {
    throw new Error("Cannot remove the last owner");
  }
  await prisma.boardMembership.delete({ where: { userId_boardId: { userId, boardId } } });
  revalidatePath(`/boards/${boardId}/members`);
}

/** Promote target to OWNER, step the caller down to TEAM (caller must be OWNER). */
export async function transferOwnership(boardId: string, targetUserId: string) {
  const principal = await getPrincipal();
  await assertCan(principal, boardId, "ownership:transfer");
  const target = await prisma.boardMembership.findUnique({
    where: { userId_boardId: { userId: targetUserId, boardId } },
    select: { userId: true },
  });
  if (!target) throw new Error("Target must already be a member");
  await prisma.$transaction([
    prisma.boardMembership.update({
      where: { userId_boardId: { userId: targetUserId, boardId } },
      data: { role: "OWNER" },
    }),
    prisma.boardMembership.update({
      where: { userId_boardId: { userId: principal!.userId, boardId } },
      data: { role: "TEAM" },
    }),
  ]);
  revalidatePath(`/boards/${boardId}/members`);
}
