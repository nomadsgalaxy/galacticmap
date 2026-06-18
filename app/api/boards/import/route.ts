import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/app/lib/session";
import { importBoard } from "@/app/lib/board-io";

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB (embedded image assets)

// Import a canonical JSON board (any authenticated user; becomes its OWNER).
export async function POST(req: NextRequest) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let doc: unknown;
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
      if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });
      doc = JSON.parse(await file.text());
    } else {
      doc = await req.json();
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const id = await importBoard(principal.userId, doc);
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
