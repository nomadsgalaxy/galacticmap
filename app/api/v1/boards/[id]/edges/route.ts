import { authed, handle, json, readJson } from "@/app/api/v1/_http";
import { createEdgeSvc } from "@/app/lib/board-service";

// POST /api/v1/boards/:id/edges { sourceId, targetId, label? } — create a connector edge.
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "write");
    const { id } = await params;
    const body = await readJson(req);
    if (typeof body.sourceId !== "string" || typeof body.targetId !== "string") {
      return json({ error: "validation", message: "'sourceId' and 'targetId' are required" }, 400);
    }
    const edge = await createEdgeSvc(principal, id, {
      sourceId: body.sourceId,
      targetId: body.targetId,
      label: typeof body.label === "string" ? body.label : null,
    });
    return json({ edge }, 201);
  });
}
