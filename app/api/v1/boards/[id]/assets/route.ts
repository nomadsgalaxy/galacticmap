import { authed, handle, json } from "@/app/api/v1/_http";
import { ApiError } from "@/app/lib/board-service";
import { uploadBoardImage } from "@/app/lib/agent-images";

// POST /api/v1/boards/:id/assets   body: the raw image bytes (PNG, JPEG, GIF or WebP, ≤10 MB)
// Uploads an image to the board and returns its assetId. Put it on the board with an image node:
// {op:"add_node", type:"image", data:{assetId, alt}}.
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const principal = await authed(req, "write");
    const { id } = await params;
    if (Number(req.headers.get("content-length")) > 10 * 1024 * 1024) throw new ApiError(413, "Images can be at most 10 MB", "too_large");
    const asset = await uploadBoardImage(principal, id, Buffer.from(await req.arrayBuffer()));
    return json(asset, 201);
  });
}
