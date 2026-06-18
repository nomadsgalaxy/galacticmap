import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { prisma } from "@/app/lib/db";
import { tags } from "@/app/lib/cache-tags";
import { getPrincipal } from "@/app/lib/session";
import { authorize } from "@/app/lib/authz";

// Debounced high-frequency position/size persistence (plan.md §8: Route Handler, not a Server Action).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: boardId } = await params;
  const access = await authorize(await getPrincipal(), boardId, "node:move");
  if (!access.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const positions = body?.positions;
  if (!Array.isArray(positions)) {
    return NextResponse.json({ error: "positions[] required" }, { status: 400 });
  }

  const updates = positions
    .slice(0, 1000)
    .filter(
      (p) =>
        p && typeof p.id === "string" && Number.isFinite(p.x) && Number.isFinite(p.y),
    );

  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map((p) =>
        prisma.node.updateMany({
          where: { id: p.id, boardId }, // scoped: can't move another board's node
          data: {
            posX: p.x,
            posY: p.y,
            ...(Number.isFinite(p.width) ? { width: p.width } : {}),
            ...(Number.isFinite(p.height) ? { height: p.height } : {}),
            ...(Number.isFinite(p.zIndex) ? { zIndex: p.zIndex } : {}),
          },
        }),
      ),
    );
    // Immediate bust (not SWR) so a hard reload never loads a stale position.
    revalidateTag(tags.board(boardId), { expire: 0 });
  }

  return NextResponse.json({ ok: true, updated: updates.length });
}
