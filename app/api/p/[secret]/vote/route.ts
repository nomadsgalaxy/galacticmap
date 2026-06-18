import { NextRequest, NextResponse } from "next/server";
import { voteSuggestion } from "@/app/lib/public-db";
import { getClientIp } from "@/app/lib/net";
import { publishLive } from "@/app/lib/live-bus";

// Anonymous up/down vote on one suggestion item. Imports ONLY the restricted public-db surface. On
// success, fans the new tally out to all spectators + the editor over the bus ("sug-vote", ids+counts).
export async function POST(req: NextRequest, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.authorToken !== "string" || typeof body.suggestionId !== "string" || typeof body.tempId !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const value = Number(body.value);
  const ip = getClientIp(req);
  const res = await voteSuggestion(secret, body.authorToken, body.suggestionId, body.tempId, Number.isFinite(value) ? value : 0, ip);
  if (!res.ok) {
    return NextResponse.json({ error: res.error, ...(res.retryAfter ? { retryAfter: res.retryAfter } : {}) }, { status: res.status });
  }
  publishLive(res.boardId, JSON.stringify({ type: "sug-vote", suggestionId: res.suggestionId, tempId: res.tempId, up: res.up, down: res.down }));
  return NextResponse.json({ ok: true, up: res.up, down: res.down, my: res.my });
}
