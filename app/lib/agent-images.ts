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

const RASTER = new Set(["png", "jpeg", "gif", "webp"]);

// Bytes for an asset this board may show: uploaded to this board, or by the token's own user. A node's
// assetId is client-supplied, so this stops a writer from pointing a node at someone else's upload.
// Older uploads were stored under whatever type the browser claimed, so only hand sharp real raster images
// (an SVG renamed .png would otherwise go through librsvg).
async function boardAsset(principal: ApiPrincipal, boardId: string, assetId: string) {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { storageKey: true, mimeType: true, userId: true, boardId: true } });
  if (!asset?.storageKey || (asset.boardId !== boardId && asset.userId !== principal.userId)) return null;
  try {
    const buf = await getStorage().get(asset.storageKey);
    const meta = await sharp(buf, { animated: false }).metadata();
    return meta.format && RASTER.has(meta.format) ? { buf, mime: asset.mimeType } : null;
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
const MAX_THUMBS = 60; // past this, images draw as placeholders; use focus to see them
const THUMB_BATCH = 4; // decode a few at a time so one snapshot can't hog the server

// Whether this server can draw text at all. librsvg needs a system font; without one, labels render blank
// or as the same placeholder box for every character, which looks like a working picture. So draw two
// different words and require real, different ink. Checked once, then reported with each snapshot.
let fontsOk: Promise<boolean> | null = null;
const ink = (t: string) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><rect width="60" height="30" fill="#fff"/><text x="2" y="24" font-size="26" font-family="sans-serif" fill="#000">${t}</text></svg>`))
    .stats().then((st) => st.channels[0].mean);
export function canDrawText(): Promise<boolean> {
  fontsOk ??= Promise.all([ink("Hi"), ink("Ag")])
    .then(([a, b]) => {
      const ok = a < 254 && b < 254 && Math.abs(a - b) > 1;
      if (!ok) console.error("[agent-images] no usable font: board snapshots will have blank labels. Install a font package (e.g. fonts-dejavu-core) in the server image.");
      return ok;
    })
    .catch(() => false);
  return fontsOk;
}

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
  const inView = board.nodes.filter((n) => {
    if (n.type !== "image") return false;
    const r = rectOf(n);
    return r.x < region.x + region.w && r.x + r.w > region.x && r.y < region.y + region.h && r.y + r.h > region.y;
  });
  const thumbs = inView.slice(0, MAX_THUMBS);
  for (let i = 0; i < thumbs.length; i += THUMB_BATCH) await Promise.all(thumbs.slice(i, i + THUMB_BATCH).map(async (n) => {
    const r = rectOf(n);
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
  const notes = [
    ...(await canDrawText() ? [] : ["This server has no fonts installed, so labels and numbers in the picture are blank. Use the legend and describe_board."]),
    ...(inView.length > MAX_THUMBS ? [`${inView.length - MAX_THUMBS} images beyond the first ${MAX_THUMBS} are drawn as placeholders. Use focus to zoom in.`] : []),
  ];
  return { png, legend, notes, region: drawn, title: board.title };
}
