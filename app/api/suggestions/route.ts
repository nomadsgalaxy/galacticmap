import { NextRequest, NextResponse } from "next/server";
import { submitSuggestion } from "@/app/lib/public-db";
import { getClientIp } from "@/app/lib/net";

// Anonymous suggestion intake (no auth). Imports ONLY the restricted publicDb boundary.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.secret !== "string" || typeof body.proposal !== "object") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const ip = getClientIp(req);
  const ua = req.headers.get("user-agent") ?? undefined;
  const res = await submitSuggestion(
    body.secret,
    { authorName: typeof body.authorName === "string" ? body.authorName : undefined, proposal: body.proposal },
    ip,
    ua,
  );
  if (res.ok) return NextResponse.json({ ok: true });
  return NextResponse.json(
    { error: res.error, ...(res.retryAfter ? { retryAfter: res.retryAfter } : {}) },
    { status: res.status },
  );
}
