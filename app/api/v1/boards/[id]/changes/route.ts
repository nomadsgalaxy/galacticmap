import { authed, handle, json, readJson } from "@/app/api/v1/_http";
import { applyChanges } from "@/app/lib/agent-service";

// POST /api/v1/boards/:id/changes
// { ops: [...], mode?: "apply" | "propose", dryRun?: boolean }
// A batch of add/update/delete ops for nodes, connectors and groups, applied together (all or nothing).
// New things take a `ref` that later ops can use in place of an id. Nodes without x/y are placed in free
// space next to `place.near` / `place.in` / their parent. mode "propose" turns additions into a pending
// suggestion the board's editors review instead. See the MCP server's apply_changes tool for the op list.
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "write");
    const { id } = await params;
    const result = await applyChanges(principal, id, await readJson(req));
    return json(result, result.applied ? 201 : 200);
  });
}
