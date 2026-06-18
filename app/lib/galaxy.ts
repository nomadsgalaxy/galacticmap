import { prisma } from "@/app/lib/db";
import type { Principal } from "@/app/lib/authz";

// Cross-board "galaxy" reads (#11). Per-principal + dynamic — call inside <Suspense>.
// A board is visible iff the principal has a membership on it; a hyperlane is visible iff BOTH of
// its endpoint boards are visible to the principal (composes with RBAC, never leaks a board's
// existence to a non-member).

export type GalaxyBoard = { id: string; title: string; nodeCount: number; role: string };
export type GalaxyLink = {
  id: string;
  source: string;
  target: string;
  label: string | null;
  sourceNodeId: string | null;
  targetNodeId: string | null;
};

export async function listGalaxy(
  principal: Principal,
): Promise<{ boards: GalaxyBoard[]; links: GalaxyLink[] }> {
  if (!principal) return { boards: [], links: [] };
  const rows = await prisma.board.findMany({
    where: { memberships: { some: { userId: principal.userId } } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      _count: { select: { nodes: true } },
      memberships: { where: { userId: principal.userId }, select: { role: true } },
    },
  });
  const boards: GalaxyBoard[] = rows.map((b) => ({
    id: b.id,
    title: b.title,
    nodeCount: b._count.nodes,
    role: b.memberships[0]?.role ?? "VISITOR",
  }));
  const visible = new Set(boards.map((b) => b.id));
  if (visible.size === 0) return { boards, links: [] };

  // Only links whose BOTH endpoints are visible to this principal.
  const linkRows = await prisma.crossBoardLink.findMany({
    where: {
      sourceBoardId: { in: [...visible] },
      targetBoardId: { in: [...visible] },
    },
    select: { id: true, sourceBoardId: true, targetBoardId: true, label: true, sourceNodeId: true, targetNodeId: true },
  });
  const links: GalaxyLink[] = linkRows.map((l) => ({
    id: l.id,
    source: l.sourceBoardId,
    target: l.targetBoardId,
    label: l.label,
    sourceNodeId: l.sourceNodeId,
    targetNodeId: l.targetNodeId,
  }));
  return { boards, links };
}
