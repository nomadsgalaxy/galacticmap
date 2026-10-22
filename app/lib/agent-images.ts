// Pictures for AI agents: an image node's actual image, and the whole board (or part of it) rendered as a
// PNG. Both go through the same board:view gate as describe_board, so a token sees no more than its user.
import sharp from "sharp";
import { prisma } from "@/app/lib/db";
import type { ApiPrincipal } from "@/app/lib/api-token";
import { getStorage } from "@/app/lib/storage/driver";
import { ApiError, getBoardFull } from "@/app/lib/board-service";
import { rectOf, union, type Rect } from "@/app/lib/board-layout";
import { snapshotSvg } from "@/app/lib/board-snapshot";
import { imageCaption } from "@/app/lib/board-outline";

// Bytes for an asset this board may show: uploaded to this board, or by the token's own user. A node's
// assetId is client-supplied, so this stops a writer from pointing a node at someone else's upload.
async function boardAsset(principal: ApiPrincipal, boardId: string, assetId: string) {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { storageKey: true, mimeType: true, userId: true, boardId: true } });
  if (!asset?.storageKey || (asset.boardId !== boardId && asset.userId !== principal.userId)) return null;
  try {
    return { buf: await getStorage().get(asset.storageKey), mime: asset.mimeType };
  } catch {
    return null;
  }
}

/** An image node's picture, scaled so its long edge is at most `max` px. PNG stays PNG (transparency), the rest become JPEG. */
export async function nodeImage(principal: ApiPrincipal, boardId: string, nodeId: string, max = 1568) {
  const board = await getBoardFull(principal, boardId); // gates board:view
  const node = board.nodes.find((n) => n.id === nodeId);
  if (!node) throw new ApiError(404, "Node not found", "not_found");
  if (node.type !== "image") throw new ApiError(400, `Node is a ${node.type}, not an image`, "not_image");
  const alt = imageCaption(node.data.alt).caption || null; // a bare file name isn't a caption
  const asset = await boardAsset(principal, boardId, String(node.data.assetId));
  if (!asset) throw new ApiError(404, "The image file for this node is missing", "asset_missing");
  const img = sharp(asset.buf, { animated: false }).rotate().resize(max, max, { fit: "inside", withoutEnlargement: true });
  const png = asset.mime === "image/png";
  const buf = await (png ? img.png() : img.jpeg({ quality: 85 })).toBuffer();
  return { buf, mime: png ? "image/png" : "image/jpeg", alt };
}

const MARGIN = 80;

/**
 * The board as a PNG with numbered nodes, plus a legend (number → node id). `focus` is a group or node id to
 * zoom to (with the nodes around it); without it the whole board is drawn.
 */
export async function boardSnapshot(principal: ApiPrincipal, boardId: string, opts: { focus?: string; width?: number } = {}) {
  const board = await getBoardFull(principal, boardId); // gates board:view
  let ids: Set<string> | null = null;
  if (opts.focus) {
    const group = board.groups.find((g) => g.id === opts.focus);
    ids = new Set(group ? group.nodeIds : [opts.focus]);
    // A node's mind-map children come along, so focusing a topic shows its branch.
    if (!group) for (let grew = true; grew;) { grew = false; for (const n of board.nodes) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) { ids.add(n.id); grew = true; } }
  }
  const u = union(board.nodes.filter((n) => !ids || ids.has(n.id)).map(rectOf));
  if (opts.focus && !u) throw new ApiError(404, "focus is not a node or group on this board", "not_found");
  const region: Rect = u ? { x: u.x - MARGIN, y: u.y - MARGIN, w: u.w + MARGIN * 2, h: u.h + MARGIN * 2 } : { x: 0, y: 0, w: 800, h: 600 };
  const width = Math.min(Math.max(opts.width ?? 1400, 400), 2400);

  // Thumbnails for image nodes in view, sized to how big they'll be drawn.
  const scale = width / region.w;
  const images = new Map<string, string>();
  await Promise.all(board.nodes.filter((n) => n.type === "image").map(async (n) => {
    const r = rectOf(n);
    if (!(r.x < region.x + region.w && r.x + r.w > region.x && r.y < region.y + region.h && r.y + r.h > region.y)) return;
    const asset = await boardAsset(principal, boardId, String(n.data.assetId));
    if (!asset) return;
    const px = Math.max(48, Math.min(512, Math.round(Math.max(r.w, r.h) * Math.min(scale, 2))));
    try {
      const thumb = await sharp(asset.buf, { animated: false }).rotate().resize(px, px, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
      images.set(String(n.data.assetId), `data:image/jpeg;base64,${thumb.toString("base64")}`);
    } catch { /* unreadable image: drawn as a placeholder */ }
  }));

  const { svg, legend, region: drawn } = snapshotSvg(board, { region, width, images });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { png, legend, region: drawn, title: board.title };
}
