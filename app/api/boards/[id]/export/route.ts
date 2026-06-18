import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/app/lib/session";
import { authorize } from "@/app/lib/authz";
import { exportBoard } from "@/app/lib/board-io";

// Download a board as a self-contained canonical JSON document (Owner/Team only).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(await getPrincipal(), id, "board:export");
  if (!access.ok) return new NextResponse("Not found", { status: 404 });

  const doc = await exportBoard(id);
  if (!doc) return new NextResponse("Not found", { status: 404 });

  const filename =
    (doc.board.title || "board").replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) + ".galacticboard.json";
  return new NextResponse(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
