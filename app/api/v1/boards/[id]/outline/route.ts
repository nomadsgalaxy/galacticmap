import { authed, handle, json } from "@/app/api/v1/_http";
import { describeBoard } from "@/app/lib/agent-service";

// GET /api/v1/boards/:id/outline[?maxChars=24000]
// The board as readable text for an AI agent: groups and areas, mind-map nesting, connectors, variables,
// with every node's id. Use GET /boards/:id for the raw JSON.
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "read");
    const { id } = await params;
    const max = Number(new URL(req.url).searchParams.get("maxChars"));
    const outline = await describeBoard(principal, id, Number.isFinite(max) && max >= 1000 ? Math.min(max, 200_000) : undefined);
    return json({ boardId: id, outline });
  });
}
