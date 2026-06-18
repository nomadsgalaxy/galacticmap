import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getBoardGraph, getBoardGroups, getBoardMeta } from "@/app/lib/boards";
import { getPrincipal } from "@/app/lib/session";
import { authorize } from "@/app/lib/authz";
import { isAIEnabled } from "@/app/lib/ai";
import { listSuggestions } from "@/app/lib/share-actions";
import { auth } from "@/auth";
import BoardCanvas, { type SuggestionDTO } from "./_components/BoardCanvas";

// cacheComponents: the dynamic session/`params` access + data load lives inside <Suspense>
// so the route shell renders immediately and the board streams in.
export default function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="h-[100dvh] w-full">
      <Suspense fallback={<BoardSkeleton />}>
        <BoardLoader params={params} />
      </Suspense>
    </main>
  );
}

async function BoardLoader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // RBAC: deny -> notFound() (404, never confirm a board exists to a non-member).
  const access = await authorize(await getPrincipal(), id, "board:view");
  if (!access.ok) notFound();

  const [meta, graph, groups, session] = await Promise.all([
    getBoardMeta(id),
    getBoardGraph(id),
    getBoardGroups(id),
    auth(),
  ]);
  if (!meta || !graph) notFound();

  const canEdit = access.role === "OWNER" || access.role === "TEAM";
  const meName = session?.user?.name || session?.user?.email || "Guest";

  // Pending public suggestions are overlaid as live ghosts on the editor (editors only).
  const initialSuggestions: SuggestionDTO[] = canEdit
    ? (await listSuggestions(id)).map((s) => ({
        id: s.id,
        authorName: s.authorName,
        payload: (s.payload as SuggestionDTO["payload"]) ?? { nodes: [], edges: [] },
        votes: s.votes,
      }))
    : [];

  return (
    <BoardCanvas
      boardId={id}
      title={meta.title}
      canEdit={canEdit}
      canManageMembers={access.role === "OWNER"}
      aiEnabled={isAIEnabled()}
      meName={meName}
      initialNodes={graph.nodes}
      initialEdges={graph.edges}
      initialGroups={groups}
      initialSuggestions={initialSuggestions}
    />
  );
}

function BoardSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-on-surface-variant">
      Loading board…
    </div>
  );
}
