import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/app/lib/db";

// Scoped personal-access tokens for the REST API (#14) + the MCP server.
// Only the sha256 hash is ever persisted; the raw token is shown to the user exactly once.
// Format: gbk_<43-char base64url> (32 random bytes). The gbk_ prefix aids secret scanners.

const PREFIX = "gbk_";

export type TokenScope = "read" | "write";
export type ApiPrincipal = { userId: string; tokenId: string; scopes: Set<TokenScope> };

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Mint a new raw token + its storable hash. The raw value is never recoverable afterwards. */
export function mintToken(): { raw: string; hash: string } {
  const raw = PREFIX + randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function parseScopes(csv: string): Set<TokenScope> {
  const s = new Set<TokenScope>();
  for (const part of csv.split(",").map((p) => p.trim().toLowerCase())) {
    if (part === "read" || part === "write") s.add(part);
  }
  if (s.has("write")) s.add("read"); // write implies read
  if (s.size === 0) s.add("read");
  return s;
}

function bearerFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const tok = m?.[1]?.trim();
  return tok && tok.startsWith(PREFIX) ? tok : null;
}

/**
 * Authenticate a request by Bearer API token. Returns the principal (with scopes) or null.
 * Roles/capabilities are still enforced per-board downstream via authorize() — the token only
 * proves identity + coarse read/write scope, never bypasses RBAC.
 */
export async function authenticateApiToken(req: Request): Promise<ApiPrincipal | null> {
  const raw = bearerFrom(req);
  if (!raw) return null;
  const hash = hashToken(raw);
  // findUnique on the unique tokenHash index already requires an exact (binary) match, and the
  // lookup key is sha256(secret) — not brute-forceable byte-by-byte — so no extra compare is needed.
  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hash },
    select: { id: true, userId: true, scopes: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  // Best-effort last-used stamp (don't fail the request if it races).
  prisma.apiToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return { userId: row.userId, tokenId: row.id, scopes: parseScopes(row.scopes) };
}
