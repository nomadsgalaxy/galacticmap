import { NextRequest, NextResponse } from "next/server";
import { upsertSuggestion } from "@/app/lib/public-db";
import { getClientIp } from "@/app/lib/net";
import { publishLive } from "@/app/lib/live-bus";

// Live anonymous suggestion intake (replaces the old "Submit" flow). A public author's whole working
// sub-graph is one PENDING Suggestion row, upserted here on every add/move/edit. Imports ONLY the
// restricted public-db surface (never canonical writes). On success, fans the public-safe ghost out to
// the board's editors over the in-memory bus; the public SSE relay deliberately DROPS these "sug" frames
// (they carry the proposal payload) — only "sug-resolved" id-only frames reach public spectators.
export async function POST(req: NextRequest, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.authorToken !== "string" || typeof body.proposal !== "object") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const ip = getClientIp(req);
  const ua = req.headers.get("user-agent") ?? undefined;
  const res = await upsertSuggestion(
    secret,
    body.authorToken,
    { authorName: typeof body.authorName === "string" ? body.authorName : undefined, proposal: body.proposal },
    ip,
    ua,
  );
  if (!res.ok) {
    return NextResponse.json(
      { error: res.error, ...(res.retryAfter ? { retryAfter: res.retryAfter } : {}) },
      { status: res.status },
    );
  }
  if (res.op === "upsert") {
    publishLive(res.boardId, JSON.stringify({ type: "sug", op: "upsert", suggestion: res.suggestion }));
    return NextResponse.json({ ok: true, suggestionId: res.suggestion.id });
  }
  if (res.op === "remove") {
    publishLive(res.boardId, JSON.stringify({ type: "sug", op: "remove", suggestionId: res.suggestionId }));
    return NextResponse.json({ ok: true, suggestionId: null });
  }
  return NextResponse.json({ ok: true, suggestionId: null });
}
