import { authed, handle, json } from "@/app/api/v1/_http";
import { prisma } from "@/app/lib/db";

// GET /api/v1/me — verify a token + return its identity and scopes (the canonical "ping").
export function GET(req: Request) {
  return handle(async () => {
    const principal = await authed(req, "read");
    const user = await prisma.user.findUnique({
      where: { id: principal.userId },
      select: { id: true, email: true, name: true, isInstanceAdmin: true },
    });
    return json({
      user,
      token: { id: principal.tokenId, scopes: [...principal.scopes] },
      api: { version: "v1" },
    });
  });
}
