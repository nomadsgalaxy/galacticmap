import { authed, handle } from "@/app/api/v1/_http";
import { nodeImage } from "@/app/lib/agent-images";

// GET /api/v1/boards/:id/nodes/:nodeId/image[?max=1568]
// An image node's picture, scaled so its long edge is at most `max` px (64–4096). Returns the image bytes.
export function GET(req: Request, { params }: { params: Promise<{ id: string; nodeId: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "read");
    const { id, nodeId } = await params;
    const max = Number(new URL(req.url).searchParams.get("max"));
    const img = await nodeImage(principal, id, nodeId, Number.isFinite(max) && max >= 64 ? Math.min(max, 4096) : undefined);
    return new Response(new Uint8Array(img.buf), {
      headers: { "content-type": img.mime, "cache-control": "no-store", ...(img.alt ? { "x-alt-text": encodeURIComponent(img.alt) } : {}) },
    });
  });
}
