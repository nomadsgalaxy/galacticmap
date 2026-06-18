import { Prisma } from "@prisma/client";
import { prisma } from "@/app/lib/db";
import { getStorage } from "@/app/lib/storage/driver";

export const BOARD_FORMAT = "galacticboard.board";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

type ExportNode = {
  id: string;
  parentId: string | null;
  type: string;
  layout: string;
  collapsed: boolean;
  order: number;
  posX: number | null;
  posY: number | null;
  width: number | null;
  height: number | null;
  zIndex: number;
  data: unknown;
  style: unknown;
};
type ExportEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  kind: string;
  type: string;
  animated: boolean;
  label: string | null;
  data: unknown;
  style: unknown;
};
type ExportAsset = { id: string; mimeType: string; byteSize: number; dataBase64: string };
export type BoardExport = {
  format: typeof BOARD_FORMAT;
  schemaVersion: number;
  board: { title: string; settings: unknown };
  nodes: ExportNode[];
  edges: ExportEdge[];
  assets: ExportAsset[];
};

const asJson = (v: unknown): Prisma.InputJsonValue | undefined =>
  v == null ? undefined : (v as Prisma.InputJsonValue);

/** Serialize a board to a self-contained, portable JSON document (image assets embedded as base64). */
export async function exportBoard(boardId: string): Promise<BoardExport | null> {
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    select: {
      title: true,
      settings: true,
      schemaVersion: true,
      nodes: {
        select: {
          id: true, parentId: true, type: true, layout: true, collapsed: true, order: true,
          posX: true, posY: true, width: true, height: true, zIndex: true, data: true, style: true,
        },
      },
      edges: {
        select: {
          id: true, sourceId: true, targetId: true, kind: true, type: true, animated: true,
          label: true, data: true, style: true,
        },
      },
    },
  });
  if (!board) return null;

  const assetIds = Array.from(
    new Set(
      board.nodes
        .filter((n) => n.type === "image")
        .map((n) => (n.data as { assetId?: string } | null)?.assetId)
        .filter((x): x is string => !!x),
    ),
  );
  const assetRows = assetIds.length
    ? await prisma.asset.findMany({
        where: { id: { in: assetIds } },
        select: { id: true, mimeType: true, byteSize: true, storageKey: true },
      })
    : [];
  const storage = getStorage();
  const assets: ExportAsset[] = [];
  for (const a of assetRows) {
    try {
      const buf = await storage.get(a.storageKey);
      assets.push({ id: a.id, mimeType: a.mimeType, byteSize: a.byteSize, dataBase64: buf.toString("base64") });
    } catch {
      /* skip missing files */
    }
  }

  return {
    format: BOARD_FORMAT,
    schemaVersion: board.schemaVersion ?? 1,
    board: { title: board.title, settings: board.settings },
    nodes: board.nodes,
    edges: board.edges,
    assets,
  };
}

/** Recreate a board from an export doc for `userId` (new ids, OWNER membership, remapped refs). */
export async function importBoard(userId: string, doc: unknown): Promise<string> {
  const d = doc as Partial<BoardExport>;
  if (!d || d.format !== BOARD_FORMAT || !Array.isArray(d.nodes)) {
    throw new Error("Invalid Galactic Map export file");
  }

  const board = await prisma.$transaction(async (tx) => {
    const b = await tx.board.create({
      data: {
        title: (d.board?.title ?? "Imported board").slice(0, 200),
        userId,
        settings: asJson(d.board?.settings),
      },
    });
    await tx.boardMembership.create({ data: { userId, boardId: b.id, role: "OWNER" } });
    return b;
  });

  // Recreate assets (new rows + files), remap ids.
  const assetMap = new Map<string, string>();
  const storage = getStorage();
  for (const a of d.assets ?? []) {
    const buf = Buffer.from(a.dataBase64, "base64");
    const asset = await prisma.asset.create({
      data: {
        userId,
        boardId: board.id,
        storageDriver: "local",
        storageKey: "",
        mimeType: a.mimeType,
        byteSize: buf.length,
      },
    });
    const key = `uploads/${asset.id}.${EXT[a.mimeType] ?? "bin"}`;
    await storage.put(key, buf);
    await prisma.asset.update({ where: { id: asset.id }, data: { storageKey: key } });
    assetMap.set(a.id, asset.id);
  }

  // Recreate nodes (parentId set in a second pass), remap asset refs.
  const nodeMap = new Map<string, string>();
  for (const n of d.nodes) {
    let data = n.data as Record<string, unknown> | null;
    if (n.type === "image" && data?.assetId && assetMap.has(String(data.assetId))) {
      data = { ...data, assetId: assetMap.get(String(data.assetId)) };
    }
    const created = await prisma.node.create({
      data: {
        boardId: board.id,
        type: n.type,
        layout: n.layout ?? "manual",
        collapsed: n.collapsed ?? false,
        order: n.order ?? 0,
        posX: n.posX,
        posY: n.posY,
        width: n.width,
        height: n.height,
        zIndex: n.zIndex ?? 0,
        data: asJson(data),
        style: asJson(n.style),
      },
    });
    nodeMap.set(n.id, created.id);
  }
  for (const n of d.nodes) {
    // never self-parent (n.parentId !== n.id) — a self-parented node hangs client tree traversals
    if (n.parentId && n.parentId !== n.id && nodeMap.has(n.parentId)) {
      await prisma.node.update({
        where: { id: nodeMap.get(n.id)! },
        data: { parentId: nodeMap.get(n.parentId)! },
      });
    }
  }

  // Recreate edges, remap endpoints.
  for (const e of d.edges ?? []) {
    const source = nodeMap.get(e.sourceId);
    const target = nodeMap.get(e.targetId);
    if (!source || !target) continue;
    await prisma.edge.create({
      data: {
        boardId: board.id,
        sourceId: source,
        targetId: target,
        kind: e.kind ?? "connector",
        type: e.type ?? "animated",
        animated: e.animated ?? true,
        label: e.label,
        data: asJson(e.data),
        style: asJson(e.style),
      },
    });
  }

  return board.id;
}
