import { NextResponse } from "next/server";
import { getPrincipal } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { publishLive, hasSubscribers } from "@/app/lib/live-bus";

// Editors POST ephemeral live events here — { type: "pos", nodes: [{id,x,y}] } during a drag, or
// { type: "refresh" } after a committed change. Relayed to public spectators via the SSE stream.
// Edit access is verified but cached briefly so a drag burst doesn't hammer the membership query.
const allow = new Map<string, number>();
const ALLOW_TTL = 4000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const key = `${principal.userId}:${id}`;
  const now = Date.now();
  if ((allow.get(key) ?? 0) < now) {
    try {
      await assertCan(principal, id, "node:edit");
    } catch {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    allow.set(key, now + ALLOW_TTL);
  }

  // Nothing watching → skip the work entirely.
  if (!hasSubscribers(id)) return NextResponse.json({ ok: true, idle: true });

  const body = await req.json().catch(() => null);
  if (!body || (body.type !== "pos" && body.type !== "refresh")) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  publishLive(id, JSON.stringify(body));
  return NextResponse.json({ ok: true });
}
