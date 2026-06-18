// Line jumps ("hops"): where one trail crosses another, the winning edge draws a small bridge (arc)
// or break (gap) so the crossing reads clearly. Pure geometry — detection + SVG-path post-processing.
import type { Pt } from "./orthogonalRoute";

const sampleCache = new Map<string, Pt[]>();

/** Sample an SVG path string into a polyline (off-DOM <path>; cached by path string). */
export function samplePath(d: string, step = 6): Pt[] {
  if (!d || typeof document === "undefined") return [];
  const hit = sampleCache.get(d);
  if (hit) return hit;
  const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
  el.setAttribute("d", d);
  let len = 0;
  try {
    len = el.getTotalLength();
  } catch {
    return [];
  }
  const n = Math.max(1, Math.ceil(len / step));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const p = el.getPointAtLength((i / n) * len);
    pts.push({ x: p.x, y: p.y });
  }
  if (sampleCache.size > 3000) sampleCache.clear();
  sampleCache.set(d, pts);
  return pts;
}

// Intersection of segment a–b with segment c–e (or null).
function segInt(a: Pt, b: Pt, c: Pt, e: Pt): Pt | null {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = e.x - c.x, sy = e.y - c.y;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * rx, y: a.y + t * ry };
}

const near = (p: Pt, q: Pt, d: number) => Math.hypot(p.x - q.x, p.y - q.y) < d;

// A crossing, located by its cumulative arc-length distance along `self` (so a hop can span the
// many short segments a sampled curve produces — not just one segment).
export type Crossing = { dist: number };

/** Crossings on `self` against each polyline in `others`. Crossings near any endpoint are ignored
 *  (those are shared-node joins, not true crossings). */
export function crossingsOf(self: Pt[], others: Pt[][], skipEnds = 16): Crossing[] {
  const out: Crossing[] = [];
  if (self.length < 2) return out;
  const s0 = self[0], s1 = self[self.length - 1];
  let cum = 0;
  for (let i = 0; i < self.length - 1; i++) {
    const a = self[i], b = self[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    for (const o of others) {
      if (o.length < 2) continue;
      const o0 = o[0], o1 = o[o.length - 1];
      for (let j = 0; j < o.length - 1; j++) {
        const p = segInt(a, b, o[j], o[j + 1]);
        if (!p) continue;
        if (near(p, s0, skipEnds) || near(p, s1, skipEnds) || near(p, o0, skipEnds) || near(p, o1, skipEnds)) continue;
        out.push({ dist: cum + Math.hypot(p.x - a.x, p.y - a.y) });
      }
    }
    cum += segLen;
  }
  return out;
}

const polyline = (pts: Pt[]): string =>
  pts.length ? `M ${pts[0].x},${pts[0].y}` + pts.slice(1).map((p) => ` L ${p.x},${p.y}`).join("") : "";

/** Rebuild a path from polyline `pts`, carving a hop (arc bridge or gap) of width `size` around each
 *  crossing, located by arc-length so it works regardless of how finely the polyline is sampled. */
export function applyJumps(pts: Pt[], crossings: Crossing[], style: "arc" | "gap", size: number): string {
  if (pts.length < 2) return "";
  const r = size / 2;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  const pointAt = (dd: number): Pt => {
    const d = Math.max(0, Math.min(total, dd));
    let i = 0;
    while (i < pts.length - 2 && cum[i + 1] < d) i++;
    const seg = cum[i + 1] - cum[i] || 1;
    const t = (d - cum[i]) / seg;
    return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
  };
  // hop centers that have room, sorted, with overlapping ones merged
  const centers = crossings.map((c) => c.dist).filter((d) => d > r + 0.5 && d < total - r - 0.5).sort((x, y) => x - y);
  const merged: number[] = [];
  for (const c of centers) if (!merged.length || c - merged[merged.length - 1] > size + 1) merged.push(c);
  if (!merged.length) return polyline(pts);

  let out = `M ${pts[0].x},${pts[0].y}`;
  let cursor = 0;
  for (const c of merged) {
    for (let i = 0; i < pts.length; i++) if (cum[i] > cursor + 0.01 && cum[i] < c - r - 0.01) out += ` L ${pts[i].x},${pts[i].y}`;
    const pa = pointAt(c - r), pb = pointAt(c + r);
    out += ` L ${pa.x},${pa.y}`;
    out += style === "arc" ? ` A ${r} ${r} 0 0 1 ${pb.x},${pb.y}` : ` M ${pb.x},${pb.y}`;
    cursor = c + r;
  }
  // Exclude the last point here and append it explicitly below — otherwise it's added twice, leaving a
  // zero-length final segment whose tangent is undefined, which flips the markerEnd arrowhead's orient.
  for (let i = 0; i < pts.length - 1; i++) if (cum[i] > cursor + 0.01) out += ` L ${pts[i].x},${pts[i].y}`;
  out += ` L ${pts[pts.length - 1].x},${pts[pts.length - 1].y}`;
  return out;
}
