import { NextResponse } from "next/server";
import { getLiveShare } from "@/app/lib/public-db";

// Public, unauthenticated live graph for a published share — polled by the public canvas so it
// mirrors the owner's edits in real time. Returns only the public-safe projection (getLiveShare).
export async function GET(_req: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const share = await getLiveShare(secret);
  if (!share) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(share, { headers: { "cache-control": "no-store" } });
}
