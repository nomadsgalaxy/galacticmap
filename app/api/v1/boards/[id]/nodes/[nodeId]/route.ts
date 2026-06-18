import { authed, handle, json, readJson } from "@/app/api/v1/_http";
import { deleteNodeSvc, updateNodeSvc, type UpdateNodeInput } from "@/app/lib/board-service";

// PATCH  /api/v1/boards/:id/nodes/:nodeId — partial update (data merges; position/size/parent/collapsed)
// DELETE /api/v1/boards/:id/nodes/:nodeId
export function PATCH(req: Request, { params }: { params: Promise<{ id: string; nodeId: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "write");
    const { id, nodeId } = await params;
    const body = await readJson(req);
    const input: UpdateNodeInput = {};
    if (body.data !== undefined) input.data = body.data as Record<string, unknown>;
    if (typeof body.x === "number") input.x = body.x;
    if (typeof body.y === "number") input.y = body.y;
    if (typeof body.width === "number" || body.width === null) input.width = body.width as number | null;
    if (typeof body.height === "number" || body.height === null) input.height = body.height as number | null;
    if (typeof body.collapsed === "boolean") input.collapsed = body.collapsed;
    if (typeof body.parentId === "string" || body.parentId === null) input.parentId = body.parentId as string | null;
    const node = await updateNodeSvc(principal, id, nodeId, input);
    return json({ node });
  });
}

export function DELETE(req: Request, { params }: { params: Promise<{ id: string; nodeId: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "write");
    const { id, nodeId } = await params;
    await deleteNodeSvc(principal, id, nodeId);
    return json({ deleted: nodeId });
  });
}
