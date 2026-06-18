import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  // Demo owner (instance admin). The password is taken from SEED_DEMO_PASSWORD, or a random one is
  // generated and printed once — so a public checkout never ships a working admin credential. Existing
  // installs keep their password on reseed (only a fresh create sets one).
  const existingUser = await prisma.user.findUnique({ where: { email: "demo@galacticboard.local" } });
  const user =
    existingUser ??
    (await (async () => {
      const password = process.env.SEED_DEMO_PASSWORD || randomBytes(12).toString("base64url");
      const created = await prisma.user.create({
        data: { email: "demo@galacticboard.local", name: "Demo Owner", passwordHash: await hash(password), isInstanceAdmin: true },
      });
      console.log(
        `Demo admin created: demo@galacticboard.local · password: ${password}` +
          (process.env.SEED_DEMO_PASSWORD ? "" : "  (random — set SEED_DEMO_PASSWORD to choose your own)"),
      );
      return created;
    })());

  // Idempotent: don't reseed if the demo board already exists.
  const existing = await prisma.board.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    console.log("Demo board already exists:", existing.id);
    return;
  }

  // Seed invariant: create the board + the creator's OWNER membership in one transaction.
  const board = await prisma.$transaction(async (tx) => {
    const b = await tx.board.create({
      data: {
        title: "Welcome to Galactic Map",
        userId: user.id,
        settings: { viewport: { x: 0, y: 0, zoom: 1 } },
      },
    });
    await tx.boardMembership.create({
      data: { userId: user.id, boardId: b.id, role: "OWNER" },
    });
    return b;
  });

  // A few moodboard tiles (free placement: layout = "manual").
  const n1 = await prisma.node.create({
    data: {
      boardId: board.id,
      type: "text",
      layout: "manual",
      posX: -200,
      posY: -80,
      width: 240,
      height: 100,
      data: { text: "Idea: a hybrid moodboard + mind-map" },
    },
  });
  const n2 = await prisma.node.create({
    data: {
      boardId: board.id,
      type: "text",
      layout: "manual",
      posX: 180,
      posY: -80,
      width: 220,
      height: 100,
      data: { text: "Drag me, reload — I persist." },
    },
  });
  await prisma.node.create({
    data: {
      boardId: board.id,
      type: "swatch",
      layout: "manual",
      posX: -40,
      posY: 120,
      width: 120,
      height: 120,
      data: { hex: "#6d28d9" },
    },
  });

  // One animated connector edge — the "dynamic line" (mind-map is optional; this is opt-in).
  await prisma.edge.create({
    data: {
      boardId: board.id,
      sourceId: n1.id,
      targetId: n2.id,
      type: "animated",
      animated: true,
      label: "flows to",
      data: { flowSpeed: 1 },
    },
  });

  console.log("Seeded board:", board.id);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
