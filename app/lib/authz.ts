import { prisma } from "@/app/lib/db";

// The single place mapping role -> capability (plan.md §6). Default-deny.
export type Capability =
  | "board:view"
  | "node:edit"
  | "node:move"
  | "node:delete"
  | "suggestion:accept"
  | "share:publish"
  | "share:curate"
  | "board:import"
  | "board:export"
  | "member:manage"
  | "ownership:transfer"
  | "board:delete";

export type Role = "OWNER" | "TEAM" | "VISITOR"; // "COMMENTER" reserved
export type Principal = { userId: string } | null; // null = anonymous/guest

const GRANTS: Record<Capability, ReadonlySet<Role>> = {
  "board:view": new Set(["OWNER", "TEAM", "VISITOR"]),
  "node:edit": new Set(["OWNER", "TEAM"]),
  "node:move": new Set(["OWNER", "TEAM"]),
  "node:delete": new Set(["OWNER", "TEAM"]),
  "suggestion:accept": new Set(["OWNER", "TEAM"]),
  "share:publish": new Set(["OWNER", "TEAM"]),
  "share:curate": new Set(["OWNER", "TEAM"]),
  "board:import": new Set(["OWNER", "TEAM"]),
  "board:export": new Set(["OWNER", "TEAM"]), // egress: Owner/Team only (Visitor denied)
  "member:manage": new Set(["OWNER"]),
  "ownership:transfer": new Set(["OWNER"]),
  "board:delete": new Set(["OWNER"]),
};

export class ForbiddenError extends Error {
  constructor(
    public capability: Capability,
    public boardId: string,
  ) {
    super(`Forbidden: ${capability} on board ${boardId}`);
    this.name = "ForbiddenError";
  }
}

/** Roles are read fresh per privileged call — never trusted from the JWT. */
export async function authorize(principal: Principal, boardId: string, cap: Capability) {
  if (!principal) return { ok: false as const, role: null };
  const membership = await prisma.boardMembership.findUnique({
    where: { userId_boardId: { userId: principal.userId, boardId } },
    select: { role: true },
  });
  if (!membership) return { ok: false as const, role: null };
  const role = membership.role as Role;
  const grant = GRANTS[cap]; // unknown capability key -> explicit deny (no runtime throw)
  return { ok: grant ? grant.has(role) : false, role };
}

export async function assertCan(principal: Principal, boardId: string, cap: Capability): Promise<Role> {
  const res = await authorize(principal, boardId, cap);
  if (!res.ok || !res.role) throw new ForbiddenError(cap, boardId);
  return res.role;
}
