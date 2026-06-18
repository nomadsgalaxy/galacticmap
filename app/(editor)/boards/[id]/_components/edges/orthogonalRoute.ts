// Orthogonal connector router for connectors ("trails").
//
// Two routers in ONE visual vocabulary (the "draw.io look"):
//   • orthRoute   — the clear router. Each endpoint leaves PERPENDICULAR to its node side, runs a
//                   stub straight, then the two stub ends are joined with the minimal right-angle
//                   bends: I (straight) / L (one corner) / Z (one mid-jog) / U-C (a wrap that clears
//                   the node). Total: never null, never throws, never emits NaN.
//   • routeAround — the obstacle router. Same stubs, same radius, same single continuous subpath,
//                   but the middle is solved on a sparse "interval grid" with A* + a turn penalty so
//                   it bends the fewest times around the nodes in the way. May return null, a sentinel
//                   that means "caller, fall back to orthRoute".
//
// Both end in roundedPath(pts, 10) (or curvedPath for "curve" style) so an edge never visibly snaps
// shape as a node slides into or out of the way (style parity).
//
// Provenance: derived independently from the public, well-known orthogonal / Manhattan
// connector-routing algorithm (perpendicular stub exits, minimal-bend L/Z/U joins, an interval-grid
// A* with a turn penalty) and from first principles of plane geometry. NOT derived from, and does
// not reproduce, draw.io / mxGraph source. Original work under the OpenCommunityLicense.
//
// Dependency-free on purpose — no pathfinding lib, just rectangles and a small priority queue.
//
// Spec: docs/connector-routing.md (the Test Matrix in §11 is shared by scripts/test-orthroute.mjs).

import type { Position } from "@xyflow/react";

export type Rect = { x: number; y: number; width: number; height: number };
export type Pt = { x: number; y: number };

// ── Tolerance constants — single source of truth (spec §3.1 / §12) ─────────────────────────────
const EPS_COLLINEAR = 0.5; // drop a near-duplicate / near-collinear midpoint
const ALIGN_EPS = 0.5; // cross-axis offset below this ⇒ "aligned" (unified with EPS_COLLINEAR)
const EPS_FACING = 1e-9; // sign test for "stubs face each other"
const MIN_SEG = 0.5; // shortest segment we will emit / smallest meaningful reverse
const DEF_STUB = 14; // module default stub
const DEF_RADIUS = 10; // corner radius, both routers
const DEF_MARGIN = 26; // obstacle clearance
const CORNER_LEAD = 16; // 45° diagonal lead-in off a corner anchor (px per axis)
const CORNER_MIN_SPAN = 64; // below this endpoint distance the 45° lead-in is skipped (no room to read it)

// Position is a string enum ("left"|"right"|"top"|"bottom"); map by its value so this module
// needs only the *type* of Position, not the runtime import.
const SIDE: Record<string, Pt> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
const sideOf = (p: Position): Pt => SIDE[p as string] ?? SIDE.right;

// Side endpoints leave PERPENDICULAR to their node side. Corner anchors (tl/tr/bl/br) are the one
// exception: they leave at a 45° diagonal lead-in (a "nice touch"), then hand off to the orthogonal
// dispatch — scoped to corners only, so general routing stays purely Manhattan. See orthRoute.
export const isCornerAnchor = (id?: string | null): boolean => !!id && id.length === 2;
const leaveDir = (position: Position): Pt => sideOf(position);

// Corner anchor handle id → outward unit diagonal. Used by the consumer to ask orthRoute for the 45°
// lead-in (a non-corner id maps to undefined → normal perpendicular leave).
const CORNER_DIAG: Record<string, Pt> = { tl: { x: -1, y: -1 }, tr: { x: 1, y: -1 }, bl: { x: -1, y: 1 }, br: { x: 1, y: 1 } };
export const cornerDir = (anchorId?: string | null): Pt | undefined => (anchorId ? CORNER_DIAG[anchorId] : undefined);

// ── Numeric firewall (spec §3.3) ───────────────────────────────────────────────────────────────
// A single NaN endpoint (e.g. an unmeasured node) otherwise propagates into lerp → hypot(NaN) → a
// NaN path string → SVG drops the whole edge. Coerce to a finite value so the result is debuggable.
const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);
const num = (v: number) => (Number.isFinite(v) ? v : 0);
const clampLow = (v: number, lo: number) => (v < lo ? lo : v);
const cleanPt = (p: Pt): Pt => ({ x: num(p.x), y: num(p.y) });

// Validate a passed leave vector and UNIT-normalize it, preserving its true angle — but ONLY when
// BOTH components are meaningfully non-zero (a genuine diagonal lead). A purely axis-aligned vector
// (one component ~0) is NOT a lead: it would route as a plain perpendicular leave, so return undefined.
// cornerDir still yields (±1,±1); normalized that's a 45° unit lead — geometrically the old corner
// shape. An arbitrary rotated leave keeps its real angle instead of being sign-snapped to 45°.
const normDiag = (p?: Pt): Pt | undefined => {
  if (!p) return undefined;
  const x = num(p.x), y = num(p.y);
  if (Math.abs(x) <= 1e-3 || Math.abs(y) <= 1e-3) return undefined;
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
};

// After the 45° lead, continue orthogonally on whichever of the corner's TWO sides heads more toward
// the other endpoint (so the connector respects the approach direction instead of always exiting on the
// handle's nominal side). The diagonal carries a component on each axis, so the join to either side is a
// clean 45° bend. If the target sits behind the corner (both sides point away), take the dominant axis.
// Self-cross cases that this can create are caught by the rendered-geometry fallback in orthRoute.
const cornerSide = (diag: Pt, fromPt: Pt, toPt: Pt): Pt => {
  const dx = toPt.x - fromPt.x, dy = toPt.y - fromPt.y;
  const horiz: Pt = { x: diag.x, y: 0 }, vert: Pt = { x: 0, y: diag.y };
  const hProj = diag.x * dx, vProj = diag.y * dy; // travel toward the other end along each candidate side
  if (hProj <= 0 && vProj <= 0) return Math.abs(dx) >= Math.abs(dy) ? horiz : vert;
  return hProj >= vProj ? horiz : vert;
};

const inflate = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m });

// strict-interior containment: a point exactly on the (inflated) boundary is allowed
const inside = (r: Rect, x: number, y: number) => x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height;

// General segment vs rect-interior test (Liang–Barsky). Used to decide whether the direct
// line is blocked and therefore worth rerouting.
function segCrossesRect(a: Pt, b: Pt, r: Rect): boolean {
  if (inside(r, a.x, a.y) || inside(r, b.x, b.y)) return true;
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.width - a.x, a.y - r.y, r.y + r.height - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false; // parallel and outside this edge
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// Axis-aligned segment vs rect-interior test — cheaper, used for grid edges (always H or V).
function aaSegHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  return maxX > r.x && minX < r.x + r.width && maxY > r.y && minY < r.y + r.height;
}

const uniqSorted = (xs: number[]) => [...new Set(xs.map((n) => Math.round(n)))].sort((a, b) => a - b);

// Rect-edge accessors that degrade harmlessly when the rect is absent or zero-area (spec §5.4 / §9.3):
// a missing rect contributes nothing to a max()/min().
const rRight = (r?: Rect) => (r ? r.x + r.width : -Infinity);
const rLeft = (r?: Rect) => (r ? r.x : Infinity);
const rBottom = (r?: Rect) => (r ? r.y + r.height : -Infinity);
const rTop = (r?: Rect) => (r ? r.y : Infinity);

/** Which inflated obstacles does the straight source→target line actually cross? */
export function blockingRects(a: Pt, b: Pt, obstacles: Rect[], margin: number): Rect[] {
  return obstacles.filter((r) => segCrossesRect(a, b, inflate(r, margin)));
}

type RouteInput = {
  source: Pt;
  target: Pt;
  sourcePosition: Position;
  targetPosition: Position;
  obstacles: Rect[];
  margin?: number;
  stub?: number;
  radius?: number; // NEW (optional) — default 10; MUST match the clear route's radius
  style?: "snake" | "curve"; // snake = rounded right-angles (default); curve = smooth spline
  sourceAnchor?: string; // handle id — kept for back-compat (corner detection)
  targetAnchor?: string;
  sourceRect?: Rect; // NEW (optional) — self-clearance grid lines (NOT obstacles), spec §7.3
  targetRect?: Rect; // NEW (optional)
};

/**
 * Returns a rounded orthogonal SVG path that avoids the obstacles, plus a label anchor —
 * or null when it can't improve on the direct path (no relevant obstacles / no route found),
 * in which case the caller should fall back to its normal path generator (orthRoute).
 */
export function routeAround(input: RouteInput): [string, number, number] | null {
  const margin = clampLow(finite(input.margin ?? DEF_MARGIN, DEF_MARGIN), 0);
  const radius = clampLow(finite(input.radius ?? DEF_RADIUS, DEF_RADIUS), 0);
  const rawStub = clampLow(finite(input.stub ?? DEF_STUB, DEF_STUB), 0);
  const source = cleanPt(input.source), target = cleanPt(input.target);
  const { sourcePosition, targetPosition } = input;
  const sv = leaveDir(sourcePosition), tv = leaveDir(targetPosition);

  // Only consider obstacles near the source→target region (keeps the grid small and local).
  const pad = margin * 2 + 40;
  const region: Rect = {
    x: Math.min(source.x, target.x) - pad,
    y: Math.min(source.y, target.y) - pad,
    width: Math.abs(target.x - source.x) + 2 * pad,
    height: Math.abs(target.y - source.y) + 2 * pad,
  };
  const overlapsRegion = (r: Rect) =>
    !(r.x > region.x + region.width || r.x + r.width < region.x || r.y > region.y + region.height || r.y + r.height < region.y);
  const obstacles = input.obstacles
    .filter((r) => r.width > 0 && r.height > 0 && overlapsRegion(r))
    .map((r) => inflate(r, margin));

  // Nothing in the way → caller uses the clean orthRoute instead of this avoid router. (R1)
  if (!obstacles.length) return null;

  // Style parity: same clamped effective stub as orthRoute, so the approach matches when the
  // obstacle clears and selection falls back to orthRoute (spec §6.2 / §8.1).
  const effS = effStub(rawStub, radius, source, target, sv, input.sourceRect, input.targetRect, true);
  const effT = effStub(rawStub, radius, source, target, sv, input.sourceRect, input.targetRect, false);
  const s0: Pt = { x: source.x + sv.x * effS, y: source.y + sv.y * effS };
  const t0: Pt = { x: target.x + tv.x * effT, y: target.y + tv.y * effT };

  // Self rects contribute candidate grid lines (NOT obstacles) so an avoid route that degenerates
  // to a U wraps on the same lines orthRoute uses — exact convergence across the flip (spec §7.3).
  const selfX: number[] = [], selfY: number[] = [];
  for (const r of [input.sourceRect, input.targetRect]) {
    if (!r) continue;
    const ir = inflate(r, margin);
    selfX.push(ir.x, ir.x + ir.width);
    selfY.push(ir.y, ir.y + ir.height);
  }

  // Candidate grid lines: terminals, stubs, and every obstacle edge — plus an outer ring so a
  // route can wrap around the far side of an obstacle.
  const ring = margin + 24;
  const xs = uniqSorted([
    source.x, s0.x, target.x, t0.x, region.x + ring, region.x + region.width - ring,
    ...obstacles.flatMap((r) => [r.x, r.x + r.width]),
    ...selfX,
  ]);
  const ys = uniqSorted([
    source.y, s0.y, target.y, t0.y, region.y + ring, region.y + region.height - ring,
    ...obstacles.flatMap((r) => [r.y, r.y + r.height]),
    ...selfY,
  ]);

  const key = (xi: number, yi: number) => yi * xs.length + xi;
  const xIndex = new Map(xs.map((v, i) => [v, i]));
  const yIndex = new Map(ys.map((v, i) => [v, i]));
  const si = xIndex.get(Math.round(s0.x)), sj = yIndex.get(Math.round(s0.y));
  const ti = xIndex.get(Math.round(t0.x)), tj = yIndex.get(Math.round(t0.y));
  if (si == null || sj == null || ti == null || tj == null) return null; // (R3)

  // Moves between adjacent grid lines are rejected when their segment crosses an obstacle interior
  // (see the aaSegHitsRect check below), so no separate per-vertex blocked test is needed.
  const start = key(si, sj), goal = key(ti, tj);

  // A* over the grid graph. State carries incoming direction to charge a turn penalty.
  const open: { k: number; dir: number; f: number; g: number }[] = [{ k: start, dir: -1, f: 0, g: 0 }];
  const best = new Map<number, number>([[start * 4 + 3, 0]]); // keyed by node+dir bucket
  const came = new Map<number, number>();
  const TURN = margin; // a bend costs ~one clearance unit, so we prefer straighter routes
  const hx = (xi: number, yi: number) => Math.abs(xs[xi] - xs[ti]) + Math.abs(ys[yi] - ys[tj]);

  let found = false;
  let guard = 0;
  const cap = xs.length * ys.length * 8 + 200;
  while (open.length && guard++ < cap) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.k === goal) { found = true; break; }
    const cx = cur.k % xs.length, cy = (cur.k - cx) / xs.length;
    const moves = [
      { nx: cx + 1, ny: cy, dir: 0 }, { nx: cx - 1, ny: cy, dir: 1 },
      { nx: cx, ny: cy + 1, dir: 2 }, { nx: cx, ny: cy - 1, dir: 3 },
    ];
    for (const mv of moves) {
      if (mv.nx < 0 || mv.nx >= xs.length || mv.ny < 0 || mv.ny >= ys.length) continue;
      const a = { x: xs[cx], y: ys[cy] }, b = { x: xs[mv.nx], y: ys[mv.ny] };
      if (obstacles.some((r) => aaSegHitsRect(a, b, r))) continue;
      const step = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const g = cur.g + step + (cur.dir !== -1 && cur.dir !== mv.dir ? TURN : 0);
      const nk = key(mv.nx, mv.ny);
      const bk = nk * 4 + mv.dir;
      if (best.has(bk) && best.get(bk)! <= g) continue;
      best.set(bk, g);
      came.set(bk, cur.k * 4 + (cur.dir === -1 ? 3 : cur.dir));
      open.push({ k: nk, dir: mv.dir, f: g + hx(mv.nx, mv.ny), g });
    }
  }
  if (!found) return null; // (R2)

  // Reconstruct s0..t0, then bracket with the real handle points.
  const pts: Pt[] = [];
  let dir = -1;
  // find the dir bucket we arrived at goal with (smallest g among 4 buckets)
  for (let d = 0; d < 4; d++) if (best.has(goal * 4 + d) && (dir === -1 || best.get(goal * 4 + d)! < best.get(goal * 4 + dir)!)) dir = d;
  let bucket = goal * 4 + (dir === -1 ? 3 : dir);
  const seen = new Set<number>();
  while (bucket != null && !seen.has(bucket)) {
    seen.add(bucket);
    const nk = Math.floor(bucket / 4);
    const cx = nk % xs.length, cy = (nk - cx) / xs.length;
    pts.unshift({ x: xs[cx], y: ys[cy] });
    const prev = came.get(bucket);
    if (prev == null) break;
    bucket = prev;
  }
  // Source/target appended raw (not stub tips): the path starts/ends exactly at the handle, with
  // the stub implied by the first/last grid leg (spec §7.5).
  const simplified = simplify([source, ...pts, target]);

  const [lx, ly] = labelAnchor(simplified);
  const d = input.style === "curve" ? curvedPath(simplified) : roundedPath(simplified, radius);
  return [d, lx, ly];
}

// ── Unified collinearity / dedupe (spec §3.2) ──────────────────────────────────────────────────
// ONE simplify used by orthRoute, routeAround, and pathThroughPoints. First & last points always
// survive (even when coincident). A midpoint is dropped when it is a near-duplicate of the kept
// previous point, OR when it lies on an axis-aligned run between the kept previous and the lookahead.
function simplify(full: Pt[]): Pt[] {
  if (full.length <= 1) return full.slice();
  const out: Pt[] = [full[0]];
  for (let i = 1; i < full.length - 1; i++) {
    const p = out[out.length - 1], c = full[i], n = full[i + 1];
    if (Math.abs(p.x - c.x) < EPS_COLLINEAR && Math.abs(p.y - c.y) < EPS_COLLINEAR) continue; // duplicate
    const collinear =
      (Math.abs(p.x - c.x) < EPS_COLLINEAR && Math.abs(c.x - n.x) < EPS_COLLINEAR) || // vertical run
      (Math.abs(p.y - c.y) < EPS_COLLINEAR && Math.abs(c.y - n.y) < EPS_COLLINEAR); // horizontal run
    if (!collinear) out.push(c);
  }
  out.push(full[full.length - 1]);
  return out;
}

// Closed-segment hit between two segments: ANY intersection — including a "T" (one segment's endpoint
// landing on the other's interior) OR a collinear overlap of real length. We must catch touches/overlaps
// (not just proper X crossings) because the RENDERED path rounds every corner: an ideal T-touch becomes
// a real crossing once rounded. Only ever applied to NON-adjacent segment pairs, where a shared point is
// itself a fold, so a touch counts.
function segHit(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) {
    // parallel — flag only a genuine COLLINEAR overlap of real length.
    if (Math.abs((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) > 1e-6) return false;
    const ax = Math.abs(d1x) >= Math.abs(d1y);
    const a0 = ax ? Math.min(p1.x, p2.x) : Math.min(p1.y, p2.y), a1 = ax ? Math.max(p1.x, p2.x) : Math.max(p1.y, p2.y);
    const b0 = ax ? Math.min(p3.x, p4.x) : Math.min(p3.y, p4.y), b1 = ax ? Math.max(p3.x, p4.x) : Math.max(p3.y, p4.y);
    return Math.min(a1, b1) - Math.max(a0, b0) > MIN_SEG;
  }
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  const E = 1e-6;
  return t >= -E && t <= 1 + E && u >= -E && u <= 1 + E; // CLOSED segments → touches count
}

// Does the polyline cross/touch itself (any non-adjacent pair of segments)? Used only to decide whether
// the 45° corner lead-in must fall back to a plain perpendicular route. Conservative on purpose: an
// ideal-polyline touch is treated as a crossing because rounding will make it one.
function selfCrosses(pts: Pt[]): boolean {
  for (let i = 1; i < pts.length; i++)
    for (let k = i + 2; k < pts.length; k++) {
      if (i === 1 && k === pts.length - 1) continue; // first & last segs may meet on a tiny closed loop
      if (segHit(pts[i - 1], pts[i], pts[k - 1], pts[k])) return true;
    }
  return false;
}

// The RENDERED path (rounded corners) sampled into a polyline. The corner self-cross guard runs on this,
// not the ideal polyline, because corner rounding (radius r) can turn an ideal near-miss — two segments
// passing within ~r without touching — into a real crossing in the drawn curve.
function roundedSamples(pts: Pt[], radius: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
    const a = lerp(cur, prev, Math.min(radius, dist(prev, cur) / 2));
    const b = lerp(cur, next, Math.min(radius, dist(cur, next) / 2));
    out.push(a);
    for (const t of [0.2, 0.4, 0.6, 0.8]) { // sample the quadratic arc a—cur—b
      const m = 1 - t;
      out.push({ x: m * m * a.x + 2 * m * t * cur.x + t * t * b.x, y: m * m * a.y + 2 * m * t * cur.y + t * t * b.y });
    }
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ── Effective stub clamping (spec §8.1) ────────────────────────────────────────────────────────
// When stub exceeds the inter-node gap, s1/t1 overshoot past the opposite node and a naive Z/L
// backtracks or self-crosses. Clamp the effective stub per endpoint to half the gap (minus radius),
// never below MIN_STUB. The two ends may end up with different effective stubs — allowed & correct.
function effStub(stub: number, radius: number, S: Pt, T: Pt, leave: Pt, Rs: Rect | undefined, Rt: Rect | undefined, isSource: boolean): number {
  const MIN_STUB = Math.max(radius, 4);
  // Gap used to cap the stub. Rectless: the true center distance |T−S| (a Z only self-crosses when
  // the endpoints are genuinely close; a same-side C or a far aligned pair must keep its full stub,
  // so DON'T clamp by the leave-axis projection alone — that wrongly shrinks a zero-travel-axis C).
  // With rects: the face-to-face distance along the travel axis.
  let gap = Math.hypot(T.x - S.x, T.y - S.y);
  if (Rs && Rt) {
    // distance between the two node faces along the travel axis (clamped ≥ 0)
    if (leave.x !== 0) {
      const sFace = isSource ? S.x : T.x;
      const tFace = isSource ? T.x : S.x;
      gap = Math.abs(tFace - sFace);
    } else {
      const sFace = isSource ? S.y : T.y;
      const tFace = isSource ? T.y : S.y;
      gap = Math.abs(tFace - sFace);
    }
  }
  const cap = Math.max(MIN_STUB, gap * 0.5 - radius);
  const v = Math.min(stub, cap);
  return Math.max(MIN_STUB, Math.min(stub, Math.max(v, 0)));
}

/**
 * Clean orthogonal connector (the draw.io look). Total: never returns null, never throws, never NaN.
 *   • mixed axes (one horizontal end, one vertical end) → a single corner (L), with a shallow U
 *     fallback when the corner would reverse a stub,
 *   • same axis, stub ends aligned & facing → straight (I),
 *   • same axis, facing + offset → one jog across the channel (Z),
 *   • same axis, not facing (target behind / same side) → a clean U/C that clears the node box
 *     (uses the optional source/target rects when given).
 * Rounded corners (radius 10). routeAround handles the obstacle case in the SAME style so the line
 * never snaps shape as a node moves in/out of the way.
 */
export function orthRoute(input: {
  source: Pt;
  target: Pt;
  sourcePosition: Position;
  targetPosition: Position;
  stub?: number;
  radius?: number;
  sourceRect?: Rect; // NEW (optional) — source node box, for U-turn self-clearance
  targetRect?: Rect; // NEW (optional) — target node box, for U-turn self-clearance
  sourceCorner?: Pt; // NEW (optional) — unit diagonal for a corner-anchored source (45° lead-in)
  targetCorner?: Pt; // NEW (optional) — unit diagonal for a corner-anchored target
}): [string, number, number] {
  const radius = clampLow(finite(input.radius ?? DEF_RADIUS, DEF_RADIUS), 0);
  const stub = clampLow(finite(input.stub ?? DEF_STUB, DEF_STUB), 0);
  const Sraw = cleanPt(input.source), Traw = cleanPt(input.target);
  const Rs = input.sourceRect, Rt = input.targetRect;

  // Corner anchors leave at 45°: step out a short diagonal lead, then route orthogonally FROM the lead
  // point on the handle's OWN side (the diagonal's component on that axis matches the side, so the join
  // is a clean 45° bend — never a reversal). The dispatch below is unchanged: it operates on the lead
  // points (S/T) with the normal perpendicular sides, so corners inherit the proven, no-self-cross
  // side routing; the raw corner points are bracketed back on so the path begins/ends with the diagonal.
  // The flourish needs room: skip it entirely when the endpoints are very close (the lead would be a
  // big fraction of a tiny route, and rounding then dominates into self-intersections).
  const roomy = Math.hypot(Traw.x - Sraw.x, Traw.y - Sraw.y) >= CORNER_MIN_SPAN;
  const sCorner = roomy ? normDiag(input.sourceCorner) : undefined;
  const tCorner = roomy ? normDiag(input.targetCorner) : undefined;
  const lead = clampLow(Math.min(stub, CORNER_LEAD), 1);
  const S: Pt = sCorner ? { x: Sraw.x + sCorner.x * lead, y: Sraw.y + sCorner.y * lead } : Sraw;
  const T: Pt = tCorner ? { x: Traw.x + tCorner.x * lead, y: Traw.y + tCorner.y * lead } : Traw;
  // Corner continuation heads toward the other end (respect the approach); else the handle's own side.
  const ds = sCorner ? cornerSide(sCorner, S, T) : leaveDir(input.sourcePosition);
  const dt = tCorner ? cornerSide(tCorner, T, S) : leaveDir(input.targetPosition);
  const hs = ds.x !== 0, ht = dt.x !== 0; // does each end leave horizontally?

  // Effective (clamped) stubs — same policy as routeAround for style parity.
  const effS = effStub(stub, radius, S, T, ds, Rs, Rt, true);
  const effT = effStub(stub, radius, S, T, dt, Rs, Rt, false);
  const s1: Pt = { x: S.x + ds.x * effS, y: S.y + ds.y * effS };
  const t1: Pt = { x: T.x + dt.x * effT, y: T.y + dt.y * effT };

  // clr = clearance for self-jogs (U/C) — margin-ish when rects present, else the stub.
  const clr = Rs || Rt ? DEF_MARGIN : Math.max(stub, MIN_SEG);

  let pts: Pt[];

  if (hs !== ht) {
    // ── MIXED: one corner (L), with a shallow-U fallback when the corner would reverse a stub. ──
    // The L is bad only when the corner sits BEHIND a stub tip: the post-source leg s1→C reverses ds,
    // or the pre-target leg C→t1 runs along +dt (past T, away from the stub tip) instead of toward T.
    const C: Pt = hs ? { x: t1.x, y: s1.y } : { x: s1.x, y: t1.y };
    const sourceBad = reverses(s1, C, ds); // C behind s1 on the source leave axis
    const targetBad = (t1.x - C.x) * dt.x + (t1.y - C.y) * dt.y > MIN_SEG; // C→t1 moves along +dt (overshoots T)
    if (sourceBad || targetBad) {
      pts = mixedU(S, T, s1, t1, ds, dt, hs, clr, Rs, Rt);
    } else {
      pts = [S, s1, C, t1, T];
    }
  } else if (hs) {
    // ── SAME AXIS = horizontal travel (X), offset axis Y ──
    const sameDir = ds.x === dt.x;
    const offY = t1.y - s1.y;
    const aligned = Math.abs(offY) < ALIGN_EPS;
    const facing = ds.x * (t1.x - s1.x) > EPS_FACING && dt.x * (s1.x - t1.x) > EPS_FACING;
    const gapOK = facing && (t1.x - s1.x) * Math.sign(ds.x) > MIN_SEG;
    if (sameDir) {
      pts = cClampH(S, T, s1, t1, ds.x > 0, clr, Rs, Rt);
    } else if (aligned && facing) {
      pts = [S, s1, t1, T]; // I — straight
    } else if (gapOK && !aligned) {
      const mx = (s1.x + t1.x) / 2; // Z — jog across the open channel between the stub ends
      pts = [S, s1, { x: mx, y: s1.y }, { x: mx, y: t1.y }, t1, T];
    } else {
      pts = uOffsetH(S, T, s1, t1, ds, dt, aligned, clr, Rs, Rt); // U (behind / overshoot)
    }
  } else {
    // ── SAME AXIS = vertical travel (Y), offset axis X (mirror of the H block) ──
    const sameDir = ds.y === dt.y;
    const offX = t1.x - s1.x;
    const aligned = Math.abs(offX) < ALIGN_EPS;
    const facing = ds.y * (t1.y - s1.y) > EPS_FACING && dt.y * (s1.y - t1.y) > EPS_FACING;
    const gapOK = facing && (t1.y - s1.y) * Math.sign(ds.y) > MIN_SEG;
    if (sameDir) {
      pts = cClampV(S, T, s1, t1, ds.y > 0, clr, Rs, Rt);
    } else if (aligned && facing) {
      pts = [S, s1, t1, T]; // I
    } else if (gapOK && !aligned) {
      const my = (s1.y + t1.y) / 2; // Z
      pts = [S, s1, { x: s1.x, y: my }, { x: t1.x, y: my }, t1, T];
    } else {
      pts = uOffsetV(S, T, s1, t1, ds, dt, aligned, clr, Rs, Rt); // U
    }
  }

  // Bracket the raw corner points back on → the path begins/ends with the 45° diagonal lead-in.
  if (sCorner) pts.unshift(Sraw);
  if (tCorner) pts.push(Traw);

  const simp = simplify(pts);
  // The lead offset can, in rare close/offset configs, shift an arm into the other endpoint's approach
  // corridor and self-cross (or round into one). Test the RENDERED geometry; if it crosses, drop the 45°
  // flourish and use the plain perpendicular route (proven never-self-crossing) — graceful degradation.
  if ((sCorner || tCorner) && selfCrosses(roundedSamples(simp, radius))) {
    return orthRoute({ ...input, sourceCorner: undefined, targetCorner: undefined });
  }
  const [lx, ly] = labelAnchor(simp);
  return [roundedPath(simp, radius), lx, ly];
}

// segment a→b has a component opposite `dir` on dir's axis (i.e. it forces a reversal)
function reverses(a: Pt, b: Pt, dir: Pt): boolean {
  const dot = (b.x - a.x) * dir.x + (b.y - a.y) * dir.y;
  return dot < -MIN_SEG;
}

// MIXED with a reversing corner → push out along the source leave axis past the obstruction, drop to
// the target row, then run in. Stays in the L / shallow-Z vocabulary and never re-enters a node.
function mixedU(S: Pt, T: Pt, s1: Pt, t1: Pt, ds: Pt, dt: Pt, sourceHoriz: boolean, clr: number, Rs: Rect | undefined, Rt: Rect | undefined): Pt[] {
  if (sourceHoriz) {
    // source leaves horizontally, target vertically. Push X beyond both stub tips (and rects) so the
    // turn down/up to the target row happens past the source node, then drop to t1.y and run in.
    const out = ds.x > 0
      ? Math.max(s1.x, t1.x, rRight(Rs), rRight(Rt)) + clr
      : Math.min(s1.x, t1.x, rLeft(Rs), rLeft(Rt)) - clr;
    return [S, s1, { x: out, y: s1.y }, { x: out, y: t1.y }, t1, T];
  }
  // source leaves vertically, target horizontally — mirror.
  const out = ds.y > 0
    ? Math.max(s1.y, t1.y, rBottom(Rs), rBottom(Rt)) + clr
    : Math.min(s1.y, t1.y, rTop(Rs), rTop(Rt)) - clr;
  return [S, s1, { x: s1.x, y: out }, { x: t1.x, y: out }, t1, T];
}

// Straddle test for the U self-cross guard: would a vertical/horizontal arm dropped at coordinate
// `v` slice across the span [a,b]? Inclusive of the endpoints (a column that lands AT or just past an
// endpoint still grazes the stub there, which is a real crossing), so we use an OUTWARD tolerance.
const spans = (v: number, a: number, b: number) => v >= Math.min(a, b) - MIN_SEG && v <= Math.max(a, b) + MIN_SEG;

// ── U on the perpendicular (offset) axis — opposite leave dirs, not facing (spec §4.4.3 / §5) ───
// H family: travel axis X, the back-jog runs at a Y coordinate that must clear both boxes.
//
// The naive 2-bend U [S, s1, {s1.x,my}, {t1.x,my}, t1, T] self-crosses whenever one stub column sits
// INSIDE the opposite endpoint's horizontal approach span: then the vertical arm dropped at that
// column slices through the opposite stub row. When that straddle is detected (or the pair is a pure
// 180° U-turn / aligned), we wrap the HAIRPIN instead — each vertical arm is pushed out to its own
// far side (outX / inX, past its box and stub tip), so neither arm can land inside the other's span.
function uOffsetH(S: Pt, T: Pt, s1: Pt, t1: Pt, ds: Pt, dt: Pt, aligned: boolean, clr: number, Rs: Rect | undefined, Rt: Rect | undefined): Pt[] {
  const my = clearY(s1, t1, clr, Rs, Rt);
  // 2-bend U arms: vertical at s1.x spans s1.y..my, vertical at t1.x spans my..t1.y.
  // The t1.x arm cuts the source stub row (S.x..s1.x @ s1.y) iff t1.x is inside that span AND s1.y is
  // between my and t1.y. The s1.x arm cuts the target stub row (t1.x..T.x @ t1.y) iff s1.x is inside
  // that span AND t1.y is between my and s1.y.
  const straddle =
    (spans(t1.x, S.x, s1.x) && spans(s1.y, my, t1.y)) ||
    (spans(s1.x, T.x, t1.x) && spans(t1.y, my, s1.y));
  if (!aligned && !straddle) {
    // 2-bend U: drop to the cleared row then across — safe, minimal bends.
    return [S, s1, { x: s1.x, y: my }, { x: t1.x, y: my }, t1, T];
  }
  // Hairpin (aligned 180° U-turn, OR an offset case whose 2-bend U would straddle): out on the leave
  // axis, across the cleared row, back in. Each arm clears its own box + stub tip (spec §5.2).
  const outX = ds.x > 0
    ? Math.max(s1.x, t1.x, rRight(Rs)) + clr
    : Math.min(s1.x, t1.x, rLeft(Rs)) - clr;
  const inX = dt.x > 0
    ? Math.max(s1.x, t1.x, rRight(Rt)) + clr
    : Math.min(s1.x, t1.x, rLeft(Rt)) - clr;
  return [S, s1, { x: outX, y: s1.y }, { x: outX, y: my }, { x: inX, y: my }, { x: inX, y: t1.y }, t1, T];
}

// V family mirror.
function uOffsetV(S: Pt, T: Pt, s1: Pt, t1: Pt, ds: Pt, dt: Pt, aligned: boolean, clr: number, Rs: Rect | undefined, Rt: Rect | undefined): Pt[] {
  const mx = clearX(s1, t1, clr, Rs, Rt);
  const straddle =
    (spans(t1.y, S.y, s1.y) && spans(s1.x, mx, t1.x)) ||
    (spans(s1.y, T.y, t1.y) && spans(t1.x, mx, s1.x));
  if (!aligned && !straddle) {
    return [S, s1, { x: mx, y: s1.y }, { x: mx, y: t1.y }, t1, T];
  }
  const outY = ds.y > 0
    ? Math.max(s1.y, t1.y, rBottom(Rs)) + clr
    : Math.min(s1.y, t1.y, rTop(Rs)) - clr;
  const inY = dt.y > 0
    ? Math.max(s1.y, t1.y, rBottom(Rt)) + clr
    : Math.min(s1.y, t1.y, rTop(Rt)) - clr;
  return [S, s1, { x: s1.x, y: outY }, { x: mx, y: outY }, { x: mx, y: inY }, { x: t1.x, y: inY }, t1, T];
}

// ── C (same-side, identical leave dirs) — exit, run parallel, come back (spec §4.5 / §5.3) ──────
// Normal C: out past both stub tips on the leave axis, run down/up the cross-axis offset, back in.
// Degenerate C (same-side ALIGNED, |offset| < ALIGN_EPS): the two parallel legs would collapse onto
// one line and the back of the C becomes a zero-length overlapping spur. We instead synthesize a real
// perpendicular separation of `sep = max(clr, stub)` AND guarantee a real wrap depth, so the flat-U
// survives `simplify` with a visible height — never an overlapping line (spec §5.3).
function cClampH(S: Pt, T: Pt, s1: Pt, t1: Pt, goRight: boolean, clr: number, Rs: Rect | undefined, Rt: Rect | undefined): Pt[] {
  const aligned = Math.abs(t1.y - s1.y) < ALIGN_EPS;
  // Wrap depth: at least `sep` of horizontal travel past the stub tips so the C is never flat.
  const sep = Math.max(clr, MIN_SEG);
  const depth = aligned ? sep : (Rs || Rt ? clr : 0);
  const outX = goRight
    ? Math.max(s1.x, t1.x, rRight(Rs), rRight(Rt)) + depth
    : Math.min(s1.x, t1.x, rLeft(Rs), rLeft(Rt)) - depth;
  // Return row: when aligned, push the back leg's far row out by `sep` so the two parallel legs sit on
  // genuinely separated rows that simplify keeps; the final {t1.x,ty}->t1 transition restores t1.y.
  const ty = aligned ? s1.y + sep : t1.y;
  return [S, s1, { x: outX, y: s1.y }, { x: outX, y: ty }, { x: t1.x, y: ty }, t1, T];
}

function cClampV(S: Pt, T: Pt, s1: Pt, t1: Pt, goDown: boolean, clr: number, Rs: Rect | undefined, Rt: Rect | undefined): Pt[] {
  const aligned = Math.abs(t1.x - s1.x) < ALIGN_EPS;
  const sep = Math.max(clr, MIN_SEG);
  const depth = aligned ? sep : (Rs || Rt ? clr : 0);
  const outY = goDown
    ? Math.max(s1.y, t1.y, rBottom(Rs), rBottom(Rt)) + depth
    : Math.min(s1.y, t1.y, rTop(Rs), rTop(Rt)) - depth;
  const tx = aligned ? s1.x + sep : t1.x;
  return [S, s1, { x: s1.x, y: outY }, { x: tx, y: outY }, { x: tx, y: t1.y }, t1, T];
}

// Choose the Y of an H-family back-jog: clear both boxes' Y spans, prefer the side closer to the
// natural midpoint so the U stays shallow (spec §5.1). Rectless → outside both stub tips (spec §5.4).
function clearY(s1: Pt, t1: Pt, clr: number, Rs: Rect | undefined, Rt: Rect | undefined): number {
  if (!Rs && !Rt) {
    // Outside both stub tips on whichever side is closer to the natural midpoint.
    const natural = (s1.y + t1.y) / 2;
    const below = Math.max(s1.y, t1.y) + clr;
    const above = Math.min(s1.y, t1.y) - clr;
    return Math.abs(natural - above) <= Math.abs(natural - below) ? above : below;
  }
  const topClear = Math.min(rTop(Rs), rTop(Rt), s1.y, t1.y) - clr;
  const bottomClear = Math.max(rBottom(Rs), rBottom(Rt), s1.y, t1.y) + clr;
  const natural = (s1.y + t1.y) / 2;
  return Math.abs(natural - topClear) <= Math.abs(natural - bottomClear) ? topClear : bottomClear;
}

function clearX(s1: Pt, t1: Pt, clr: number, Rs: Rect | undefined, Rt: Rect | undefined): number {
  if (!Rs && !Rt) {
    const natural = (s1.x + t1.x) / 2;
    const right = Math.max(s1.x, t1.x) + clr;
    const left = Math.min(s1.x, t1.x) - clr;
    return Math.abs(natural - left) <= Math.abs(natural - right) ? left : right;
  }
  const leftClear = Math.min(rLeft(Rs), rLeft(Rt), s1.x, t1.x) - clr;
  const rightClear = Math.max(rRight(Rs), rRight(Rt), s1.x, t1.x) + clr;
  const natural = (s1.x + t1.x) / 2;
  return Math.abs(natural - leftClear) <= Math.abs(natural - rightClear) ? leftClear : rightClear;
}

// Smooth Catmull-Rom spline through the waypoints (tension 1/6) → a flowing curve that bends
// around obstacles instead of using right-angles. Waypoints sit on the inflated clearance lines,
// so the curve's slight bulge between them stays within the node margin.
function curvedPath(pts: Pt[]): string {
  if (pts.length < 2) return pts.length === 1 ? `M ${fmt(pts[0].x)},${fmt(pts[0].y)}` : "";
  if (pts.length === 2) return `M ${fmt(pts[0].x)},${fmt(pts[0].y)} L ${fmt(pts[1].x)},${fmt(pts[1].y)}`;
  let d = `M ${fmt(pts[0].x)},${fmt(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(p2.x)},${fmt(p2.y)}`;
  }
  return d;
}

/**
 * Render a path through an explicit list of points (manual waypoints) — rounded right-angles
 * ("snake") or a smooth spline ("curve"). Drops collinear/duplicate midpoints via the unified
 * simplify (tolerant, NOT exact ===). Returns [d, labelX, labelY].
 *   • [] → ["", 0, 0]
 *   • [p] → ["M x,y", x, y] (degenerate dot)
 */
export function pathThroughPoints(points: Pt[], style: "snake" | "curve" = "snake"): [string, number, number] {
  if (!points.length) return ["", 0, 0];
  const cleaned = points.map(cleanPt);
  const pts = simplify(cleaned);
  const [lx, ly] = labelAnchor(pts);
  const d = style === "curve" ? curvedPath(pts) : roundedPath(pts, DEF_RADIUS);
  return [d, lx, ly];
}

// Build an SVG path with rounded corners through orthogonal-ish points. One continuous subpath:
// one M, then L/Q only — never a second M, never Z (protects the single comet in AnimatedEdge).
function roundedPath(pts: Pt[], radius: number): string {
  if (pts.length < 1) return "";
  if (pts.length === 1) return `M ${fmt(pts[0].x)},${fmt(pts[0].y)}`;
  if (pts.length === 2) return `M ${fmt(pts[0].x)},${fmt(pts[0].y)} L ${fmt(pts[1].x)},${fmt(pts[1].y)}`;
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  let d = `M ${fmt(pts[0].x)},${fmt(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
    const r1 = Math.min(radius, dist(prev, cur) / 2);
    const r2 = Math.min(radius, dist(cur, next) / 2);
    const a = lerp(cur, prev, r1), b = lerp(cur, next, r2);
    d += ` L ${fmt(a.x)},${fmt(a.y)} Q ${fmt(cur.x)},${fmt(cur.y)} ${fmt(b.x)},${fmt(b.y)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${fmt(last.x)},${fmt(last.y)}`;
  return d;
}

// Format a coordinate for the path string. The num() firewall upstream already guarantees finiteness;
// this is the last line of defense so no NaN/Infinity ever reaches the SVG.
const fmt = (v: number): number => (Number.isFinite(v) ? v : 0);

const lerp = (from: Pt, to: Pt, dist: number): Pt => {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) / len) * dist, y: from.y + ((to.y - from.y) / len) * dist };
};

// Label anchor: midpoint along the polyline by cumulative length. Total 0 → pts[0]. Always finite.
function labelAnchor(pts: Pt[]): [number, number] {
  if (!pts.length) return [0, 0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (half <= seg) {
      const t = seg ? half / seg : 0;
      return [pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t] as [number, number];
    }
    half -= seg;
  }
  return [pts[0].x, pts[0].y];
}
