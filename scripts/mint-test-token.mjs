// Dev-only: mint an API token for the demo user so we can curl-test /api/v1.
// Run: node --env-file=.env scripts/mint-test-token.mjs
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";

const prisma = new PrismaClient();
const ADMIN = (process.env.ADMIN_EMAILS ?? "demo@galacticboard.local").split(",")[0].trim();

const user = await prisma.user.findUnique({ where: { email: ADMIN }, select: { id: true, email: true } });
if (!user) {
  console.error("No user for", ADMIN);
  process.exit(1);
}

const raw = "gbk_" + randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(raw, "utf8").digest("hex");
await prisma.apiToken.create({ data: { userId: user.id, name: "curl-test", tokenHash: hash, scopes: "read,write" } });

// Also surface a board this user owns, for convenience.
const board = await prisma.board.findFirst({
  where: { memberships: { some: { userId: user.id, role: "OWNER" } } },
  select: { id: true, title: true },
});

console.log(JSON.stringify({ user: user.email, token: raw, ownedBoard: board }, null, 2));
await prisma.$disconnect();
