import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { prisma } from "@/app/lib/db";
import { getStorage } from "@/app/lib/storage/driver";
import { getPrincipal } from "@/app/lib/session";
import { authorize } from "@/app/lib/authz";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
// SVG intentionally excluded in Phase 1 (script-injection surface); sanitize + add later.
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Real local-file image upload (plan.md Phase 1). Phase 2 uses the authenticated user;
// Phase 6 gates serving via published-share membership.
export async function POST(req: NextRequest) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart/form-data required" }, { status: 400 });

  const file = form.get("file");
  const boardIdRaw = form.get("boardId");
  const boardId = typeof boardIdRaw === "string" && boardIdRaw.length > 0 ? boardIdRaw : null;
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (!EXT[file.type]) return NextResponse.json({ error: "unsupported image type" }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });

  // If attaching to a board, the uploader must be able to edit it.
  if (boardId) {
    const access = await authorize(principal, boardId, "node:edit");
    if (!access.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const checksum = createHash("sha256").update(buf).digest("hex");

  const asset = await prisma.asset.create({
    data: {
      userId: principal.userId,
      boardId,
      storageDriver: "local",
      storageKey: "",
      mimeType: file.type,
      byteSize: buf.length,
      checksum,
    },
  });

  const key = `uploads/${asset.id}.${EXT[file.type]}`;
  await getStorage().put(key, buf);
  await prisma.asset.update({ where: { id: asset.id }, data: { storageKey: key } });

  return NextResponse.json({ id: asset.id, url: `/api/assets/${asset.id}` });
}
