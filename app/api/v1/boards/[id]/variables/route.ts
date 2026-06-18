import { authed, handle, json } from "@/app/api/v1/_http";
import { getBoardFull } from "@/app/lib/board-service";
import { aggregate, scanVariables } from "@/app/lib/variables";

// GET /api/v1/boards/:id/variables
// Read-only. Returns every board-global tracked variable with its aggregates + raw values.
// Definitions live inline in node text / spreadsheet cells (scanned, not stored separately).
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "read");
    const { id } = await params;
    const board = await getBoardFull(principal, id); // gates board:view
    const vars = scanVariables(board.nodes);
    const variables: Record<string, ReturnType<typeof aggregate> & { values: number[] }> = {};
    for (const name of Object.keys(vars)) {
      const values = vars[name];
      variables[name] = { ...aggregate(values), values };
    }
    return json({ boardId: id, variables });
  });
}
