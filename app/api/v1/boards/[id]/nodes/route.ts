import { authed, handle, json, readJson } from "@/app/api/v1/_http";
import { createNodeSvc } from "@/app/lib/board-service";

// POST /api/v1/boards/:id/nodes
// { type: "text"|"swatch"|"image"|"link", x?, y?, parentId?, data? }
// data is validated per-type by parseNodeData (e.g. text -> {text}, swatch -> {hex}).
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "write");
    const { id } = await params;
    const body = await readJson(req);
    if (typeof body.type !== "string") {
      return json({ error: "validation", message: "'type' is required" }, 400);
    }
    const node = await createNodeSvc(principal, id, {
      type: body.type,
      x: typeof body.x === "number" ? body.x : undefined,
      y: typeof body.y === "number" ? body.y : undefined,
      parentId: typeof body.parentId === "string" ? body.parentId : body.parentId === null ? null : undefined,
      data: (body.data as Record<string, unknown>) ?? {},
    });
    return json({ node }, 201);
  });
}
