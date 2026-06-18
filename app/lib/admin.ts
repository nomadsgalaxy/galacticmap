import { notFound } from "next/navigation";
import { prisma } from "@/app/lib/db";
import { requireUserId } from "@/app/lib/session";

// Instance-admin surface. "Admin" = User.isInstanceAdmin (synced from ADMIN_EMAILS at sign-in) —
// NOT a per-board role. Every admin read/action funnels through requireInstanceAdmin() (404 to
// non-admins, never confirming the surface exists).

export async function requireInstanceAdmin(): Promise<string> {
  const userId = await requireUserId(); // redirects anon -> /login
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isInstanceAdmin: true } });
  if (!u?.isInstanceAdmin) notFound();
  return userId;
}

export async function isInstanceAdmin(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isInstanceAdmin: true } });
  return !!u?.isInstanceAdmin;
}

export async function getAdminOverview() {
  const [
    userCount, boardCount, nodeCount, edgeCount, assetCount,
    publishedShares, tokenCount, crossLinkCount, versionCount, groupCount,
    pendingSuggestions, users, boards, shares,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.board.count(),
    prisma.node.count(),
    prisma.edge.count(),
    prisma.asset.count(),
    prisma.publicShare.count({ where: { isPublished: true } }),
    prisma.apiToken.count(),
    prisma.crossBoardLink.count(),
    prisma.boardVersion.count(),
    prisma.nodeGroup.count(),
    prisma.suggestion.count({ where: { status: "PENDING" } }),
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, email: true, name: true, isInstanceAdmin: true, createdAt: true,
        _count: { select: { boards: true, memberships: true, apiTokens: true } },
      },
    }),
    prisma.board.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true, title: true, createdAt: true, updatedAt: true,
        user: { select: { email: true } },
        _count: { select: { nodes: true, edges: true, memberships: true } },
        publicShares: { where: { isPublished: true }, select: { id: true } },
      },
    }),
    prisma.publicShare.findMany({
      where: { isPublished: true },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true, secret: true, suggestionsOpen: true,
        board: { select: { id: true, title: true } },
        _count: { select: { suggestions: true } },
      },
    }),
  ]);

  return {
    stats: {
      users: userCount, boards: boardCount, nodes: nodeCount, edges: edgeCount, assets: assetCount,
      publishedShares, tokens: tokenCount, crossLinks: crossLinkCount, versions: versionCount,
      groups: groupCount, pendingSuggestions,
    },
    users: users.map((u) => ({
      id: u.id, email: u.email, name: u.name, isInstanceAdmin: u.isInstanceAdmin,
      createdAt: u.createdAt.toISOString(),
      boards: u._count.boards, memberships: u._count.memberships, tokens: u._count.apiTokens,
    })),
    boards: boards.map((b) => ({
      id: b.id, title: b.title, owner: b.user.email,
      nodes: b._count.nodes, edges: b._count.edges, members: b._count.memberships,
      published: b.publicShares.length > 0,
      updatedAt: b.updatedAt.toISOString(),
    })),
    shares: shares.map((s) => ({
      id: s.id, secret: s.secret, suggestionsOpen: s.suggestionsOpen,
      boardId: s.board.id, boardTitle: s.board.title, suggestions: s._count.suggestions,
    })),
  };
}
