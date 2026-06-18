import { authed, handle, json } from "@/app/api/v1/_http";
import { getBoardFull } from "@/app/lib/board-service";

// GET /api/v1/boards/:id — full board (meta + nodes + connector edges). Tree edges are derived
// from node.parentId by clients (see SnapshotNode.parentId).
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "read");
    const { id } = await params;
    return json({ board: await getBoardFull(principal, id) });
  });
}
