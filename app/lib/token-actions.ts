"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/app/lib/db";
import { requireUserId } from "@/app/lib/session";
import { mintToken, parseScopes } from "@/app/lib/api-token";

// Server actions backing the API-token settings page. The raw token is returned exactly once
// (from createApiToken) and never stored — only its sha256 hash lives in the DB.

export async function listApiTokens() {
  const userId = await requireUserId();
  return prisma.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, scopes: true, lastUsedAt: true, expiresAt: true, createdAt: true },
  });
}

/** Returns the raw token ONCE. Caller must surface it immediately; it is unrecoverable. */
export async function createApiToken(formData: FormData): Promise<{ id: string; raw: string }> {
  const userId = await requireUserId();
  const name = (formData.get("name")?.toString().trim() || "API token").slice(0, 80);
  const scopeChoice = formData.get("scope")?.toString() === "read" ? "read" : "read,write";
  const scopes = [...parseScopes(scopeChoice)].join(",");
  const { raw, hash } = mintToken();
  const token = await prisma.apiToken.create({
    data: { userId, name, tokenHash: hash, scopes },
    select: { id: true },
  });
  revalidatePath("/settings/tokens");
  return { id: token.id, raw };
}

export async function revokeApiToken(tokenId: string): Promise<{ ok: true }> {
  const userId = await requireUserId();
  // Scope the delete to the owner so one user can't revoke another's token.
  await prisma.apiToken.deleteMany({ where: { id: tokenId, userId } });
  revalidatePath("/settings/tokens");
  return { ok: true };
}
