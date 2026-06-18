import { NextResponse } from "next/server";
import { getPublicSuggestions } from "@/app/lib/public-db";

// Public list of everyone's PENDING suggestions (public-safe projection + per-item vote tallies). Lets
// a visitor see what others have proposed. Imports ONLY the restricted public-db surface.
export async function GET(_req: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const suggestions = await getPublicSuggestions(secret);
  return NextResponse.json({ suggestions }, { headers: { "cache-control": "no-store" } });
}
