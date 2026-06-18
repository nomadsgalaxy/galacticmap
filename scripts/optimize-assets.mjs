// One-time backfill: downscale + WebP-recompress oversized stored images so existing assets match what
// new uploads now get (≤2048px longest edge, WebP q85). Safe: writes to a NEW "<id>.opt.webp" key and
// leaves the original file in place as a backup; only the DB row is repointed. Skips GIFs + already-lean
// images; never enlarges; keeps the original if re-encoding wouldn't shrink it.
//
//   Dry run:  npx tsx scripts/optimize-assets.mjs
//   Apply:    npx tsx scripts/optimize-assets.mjs --apply
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Absolute DB path — avoids Prisma's relative-sqlite-path ambiguity when run outside the Next/CLI context.
const dbAbs = path.join(root, "data", "app.db").replace(/\\/g, "/");
process.env.DATABASE_URL = process.env.DATABASE_URL || `file:${dbAbs}`;
const dataRoot = path.join(root, "data");
const full = (key) => path.join(dataRoot, key);

const APPLY = process.argv.includes("--apply");
const MAX = 2048;
const RASTER = new Set(["image/png", "image/jpeg", "image/webp"]);
const kb = (n) => `${Math.round(n / 1024)}KB`;

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

let scanned = 0, optimized = 0, skipped = 0, errors = 0, saved = 0;
const assets = await prisma.asset.findMany({ select: { id: true, storageKey: true, mimeType: true, byteSize: true } });
console.log(`${assets.length} assets · mode: ${APPLY ? "APPLY" : "DRY-RUN (pass --apply to write)"}`);

for (const a of assets) {
  scanned++;
  if (!a.storageKey || !RASTER.has(a.mimeType)) { skipped++; continue; }
  let buf;
  try { buf = await fs.readFile(full(a.storageKey)); } catch { console.log(`  ✗ missing ${a.storageKey}`); errors++; continue; }
  try {
    const meta = await sharp(buf).metadata();
    const big = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (big <= MAX && buf.length <= 1_000_000) { skipped++; continue; } // already lean
    const out = await sharp(buf).rotate().resize(MAX, MAX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    if (out.length >= buf.length) { skipped++; continue; } // re-encode wouldn't help
    saved += buf.length - out.length;
    optimized++;
    console.log(`  ${APPLY ? "→" : "would"} ${a.id}: ${big}px ${kb(buf.length)} → ${kb(out.length)}`);
    if (APPLY) {
      const newKey = `uploads/${a.id}.opt.webp`; // new key → original file kept as backup
      await fs.mkdir(path.dirname(full(newKey)), { recursive: true });
      await fs.writeFile(full(newKey), out);
      const checksum = createHash("sha256").update(out).digest("hex");
      for (let i = 0; ; i++) {
        try { await prisma.asset.update({ where: { id: a.id }, data: { storageKey: newKey, mimeType: "image/webp", byteSize: out.length, checksum } }); break; }
        catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 300)); } // SQLite lock retry
      }
    }
  } catch (e) { console.log(`  ✗ ${a.id}: ${e.message}`); errors++; }
}

console.log(`\nscanned ${scanned} · optimized ${optimized} · skipped ${skipped} · errors ${errors} · saved ~${kb(saved)}`);
await prisma.$disconnect();
