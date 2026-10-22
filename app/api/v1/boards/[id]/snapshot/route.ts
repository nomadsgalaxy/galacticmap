import { authed, handle, json } from "@/app/api/v1/_http";
import { boardSnapshot } from "@/app/lib/agent-images";

// GET /api/v1/boards/:id/snapshot[?focus=<groupId|nodeId>&width=1400]
// The board drawn as a PNG for an AI agent to look at: every node carries a number, and `legend` maps each
// number to its node id. `focus` zooms to a group, or to a node and its mind-map branch.
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "read");
    const { id } = await params;
    const q = new URL(req.url).searchParams;
    const width = Number(q.get("width"));
    const snap = await boardSnapshot(principal, id, { focus: q.get("focus") ?? undefined, width: Number.isFinite(width) && width > 0 ? width : undefined });
    return json({ boardId: id, title: snap.title, region: snap.region, legend: snap.legend, notes: snap.notes, mimeType: "image/png", data: snap.png.toString("base64") });
  });
}
