import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/app/lib/db";
import { getStorage } from "@/app/lib/storage/driver";
import { getPrincipal } from "@/app/lib/session";

// Serve an uploaded asset to its owner or a member of its board.
// Phase 6 (plan.md §7) adds anonymous access when the asset is referenced by a
// node in a currently-published share.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: { storageKey: true, mimeType: true, userId: true, boardId: true },
  });
  if (!asset || !asset.storageKey) return new NextResponse("Not found", { status: 404 });

  const principal = await getPrincipal();
  let allowed = false;
  let isPublic = false;
  if (principal) {
    if (asset.userId === principal.userId) {
      allowed = true;
    } else if (asset.boardId) {
      const membership = await prisma.boardMembership.findUnique({
        where: { userId_boardId: { userId: principal.userId, boardId: asset.boardId } },
        select: { userId: true },
      });
      allowed = !!membership;
    }
  }

  // Anonymous (public) access: the asset's board must have a PUBLISHED share AND an image node on that
  // board must actually reference this asset. This keeps private/orphaned uploads off the public link —
  // only images placed on a published board are served. (plan.md §7, Phase 6.)
  if (!allowed && asset.boardId) {
    const share = await prisma.publicShare.findFirst({
      where: { boardId: asset.boardId, isPublished: true },
      select: { id: true },
    });
    if (share) {
      const imageNodes = await prisma.node.findMany({
        where: { boardId: asset.boardId, type: "image" },
        select: { data: true },
      });
      if (imageNodes.some((n) => (n.data as { assetId?: string } | null)?.assetId === id)) {
        allowed = true;
        isPublic = true;
      }
    }
  }

  if (!allowed) return new NextResponse("Not found", { status: 404 });

  try {
    const buf = await getStorage().get(asset.storageKey);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        // An asset id maps to immutable bytes (each upload is a NEW id), so cache hard. Private (member)
        // assets cache per-user in the browser for a year. Public assets are shareable/CDN-cacheable, but
        // capped at a day so unpublishing a board revokes edge-cached images within ~24h.
        "Cache-Control": isPublic
          ? "public, max-age=86400, immutable"
          : "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
