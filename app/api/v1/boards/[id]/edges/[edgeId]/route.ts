import { authed, handle, json } from "@/app/api/v1/_http";
import { deleteEdgeSvc } from "@/app/lib/board-service";

// DELETE /api/v1/boards/:id/edges/:edgeId
export function DELETE(req: Request, { params }: { params: Promise<{ id: string; edgeId: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "write");
    const { id, edgeId } = await params;
    await deleteEdgeSvc(principal, id, edgeId);
    return json({ deleted: edgeId });
  });
}
