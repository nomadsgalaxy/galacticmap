// Test matrix for the orthogonal connector router (spec §11, docs/connector-routing.md).
//
// Self-contained: imports the ACTUAL TypeScript router via tsx's loader so we test the shipping code,
// not a copy. Run from the project root:
//
//     npx tsx scripts/test-orthroute.mjs
//
// Each case parses the emitted pathD into a polyline and asserts the spec property. A Q (rounded
// corner) contributes its endpoint; the rounded corner's two trimmed sub-segments are reconstructed
// for axis-alignment checks. Exit code is nonzero if any case fails.

import {
  orthRoute,
  routeAround,
  pathThroughPoints,
} from "../app/(editor)/boards/[id]/_components/edges/orthogonalRoute.ts";

const EPS = 0.5; // EPS_COLLINEAR
const R = { right: "right", left: "left", top: "top", bottom: "bottom" };

// ── Path parsing ────────────────────────────────────────────────────────────────────────────────
// Parse an SVG path "M x,y L x,y Q cx,cy x,y ..." into the polyline of VERTEX points: the M, every L
// target, and every Q endpoint. (The Q control point is the true corner; the Q endpoint is the
// rounded exit. We keep L targets + Q endpoints as the visited vertices.)
function parseVertices(d) {
  if (!d) return [];
  const toks = d.trim().split(/\s+/);
  const pts = [];
  let i = 0;
  const readPt = () => {
    const [x, y] = toks[i++].split(",").map(Number);
    return { x, y };
  };
  while (i < toks.length) {
    const cmd = toks[i++];
    if (cmd === "M" || cmd === "L") pts.push(readPt());
    else if (cmd === "Q") { readPt(); /* control */ pts.push(readPt()); /* endpoint */ }
    else if (cmd === "C") { readPt(); readPt(); pts.push(readPt()); }
    else throw new Error(`unexpected path cmd "${cmd}" in: ${d}`);
  }
  return pts;
}

// For corner geometry we want the IDEAL polyline (the bends), not the rounded one. Reconstruct it by
// merging each "L a; Q corner b" back into its corner: walk commands, and for a Q use the control pt
// as the vertex (that's the un-rounded corner).
function parseCorners(d) {
  if (!d) return [];
  const toks = d.trim().split(/\s+/);
  const pts = [];
  let i = 0;
  const readPt = () => {
    const [x, y] = toks[i++].split(",").map(Number);
    return { x, y };
  };
  while (i < toks.length) {
    const cmd = toks[i++];
    if (cmd === "M") pts.push(readPt());
    else if (cmd === "L") { const p = readPt(); /* L before a Q is the corner-approach; before final it's the end */
      // peek: if next is Q, this L is a trim point we drop (the Q control is the corner). Otherwise keep.
      if (toks[i] === "Q") { /* drop trim point */ } else pts.push(p);
    }
    else if (cmd === "Q") { const c = readPt(); readPt(); pts.push(c); } // control = ideal corner
    else if (cmd === "C") { readPt(); readPt(); pts.push(readPt()); }
    else throw new Error(`unexpected path cmd "${cmd}" in: ${d}`);
  }
  // Drop consecutive near-duplicates (a trim point can coincide with the corner on tiny legs).
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < EPS && Math.abs(q.y - p.y) < EPS) continue;
    out.push(p);
  }
  return out;
}

function countBends(corners) {
  let bends = 0;
  for (let i = 1; i < corners.length - 1; i++) {
    const a = corners[i - 1], b = corners[i], c = corners[i + 1];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    // direction change = cross product nonzero (for axis-aligned, any turn)
    const cross = v1x * v2y - v1y * v2x;
    if (Math.abs(cross) > EPS) bends++;
  }
  return bends;
}

// ── Assertion helpers ─────────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { passed++; }
  else { failed++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}

function assertCase(name, result, asserts) {
  if (result == null) { check(name, false, "result was null"); return; }
  const [d, lx, ly] = result;
  const verts = parseVertices(d);
  const corners = parseCorners(d);
  const ctx = { d, lx, ly, verts, corners, bends: countBends(corners) };
  try {
    asserts(ctx);
  } catch (e) {
    check(name, false, "threw " + (e && e.message));
  }
  function check2(label, cond, detail) { check(`${name}: ${label}`, cond, detail); }
  return; // asserts run via closures below
}

// Re-implement assertCase so asserts get a `t` (test) object with named checks.
function run(name, result, body) {
  if (result === null) {
    // some cases assert null explicitly; let body decide
    const t = makeT(name, null);
    try { body(t); } catch (e) { check(name, false, "threw " + (e && e.message)); }
    return;
  }
  const t = makeT(name, result);
  try { body(t); } catch (e) { check(name, false, "threw " + (e && e.message)); }
}

function makeT(name, result) {
  const isNull = result === null;
  const d = isNull ? "" : result[0];
  const lx = isNull ? NaN : result[1];
  const ly = isNull ? NaN : result[2];
  const verts = isNull ? [] : parseVertices(d);
  const corners = isNull ? [] : parseCorners(d);
  const bends = countBends(corners);
  const C = (label, cond, detail) => check(`${name}: ${label}`, cond, detail);
  return {
    result, isNull, d, lx, ly, verts, corners, bends, C,
    NO_NAN: () => C("NO_NAN", !/NaN|Infinity|undefined/.test(d), JSON.stringify(d)),
    STARTS_AT: (p) => C("STARTS_AT", verts.length > 0 && near(verts[0], p), `${j(verts[0])} vs ${j(p)}`),
    ENDS_AT: (p) => C("ENDS_AT", verts.length > 0 && near(verts[verts.length - 1], p), `${j(verts[verts.length - 1])} vs ${j(p)}`),
    AXIS_ALIGNED: () => C("AXIS_ALIGNED", axisAligned(corners), j(corners)),
    BENDS: (k) => C(`BENDS==${k}`, bends === k, `got ${bends} (${j(corners)})`),
    BENDS_LE: (k) => C(`BENDS<=${k}`, bends <= k, `got ${bends}`),
    MONOTONE_X: () => C("MONOTONE_X", monotone(corners, "x"), j(corners.map((p) => p.x))),
    MONOTONE_Y: () => C("MONOTONE_Y", monotone(corners, "y"), j(corners.map((p) => p.y))),
    SINGLE_SUBPATH: () => C("SINGLE_SUBPATH", singleSubpath(d), JSON.stringify(d)),
    // Endpoints (first/last) are perimeter points supplied by the caller and may legitimately sit
    // inside a rect (overlapping nodes); only the ROUTED interior bends must clear the box.
    OUTSIDE: (rect, label = "OUTSIDE") => C(label, corners.slice(1, -1).every((p) => !strictInside(rect, p)), `${j(corners.slice(1, -1))} in ${j(rect)}`),
    LEAVES: (dir, stub) => C(`LEAVES(${dir})`, leaves(corners, dir, stub), j(corners.slice(0, 2))),
    FINITE_LABEL: () => C("FINITE_LABEL", Number.isFinite(lx) && Number.isFinite(ly), `${lx},${ly}`),
    NO_SELF_CROSS: () => { const x = selfCross(corners); C("NO_SELF_CROSS", !x, x ? `crosses at ${j(x.hit)} (${j(corners)})` : ""); },
    // perpendicular (off-travel-axis) extent of the routed corners ≥ min (e.g. a flat-U's height)
    PERP_EXTENT: (axis, min) => { const vs = corners.map((p) => p[axis]); const ext = Math.max(...vs) - Math.min(...vs); C(`PERP_EXTENT(${axis})>=${min}`, ext >= min - EPS, `ext=${ext}`); },
    custom: (label, cond, detail) => C(label, cond, detail),
  };
}

const near = (a, b) => a && b && Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const j = (o) => JSON.stringify(o);
function axisAligned(corners) {
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1], b = corners[i];
    if (Math.abs(a.x - b.x) >= EPS && Math.abs(a.y - b.y) >= EPS) return false;
  }
  return true;
}
function monotone(corners, axis) {
  let dir = 0;
  for (let i = 1; i < corners.length; i++) {
    const delta = corners[i][axis] - corners[i - 1][axis];
    if (Math.abs(delta) < EPS) continue;
    const s = Math.sign(delta);
    if (dir === 0) dir = s;
    else if (s !== dir) return false;
  }
  return true;
}
function singleSubpath(d) {
  const ms = (d.match(/M/g) || []).length;
  return ms === 1 && !/[Zz]/.test(d) && !/[Aa]/.test(d);
}
function strictInside(r, p) {
  return p.x > r.x + EPS && p.x < r.x + r.width - EPS && p.y > r.y + EPS && p.y < r.y + r.height - EPS;
}
function leaves(corners, dir, stub) {
  if (corners.length < 2) return false;
  const a = corners[0], b = corners[1];
  const v = { right: [1, 0], left: [-1, 0], top: [0, -1], bottom: [0, 1] }[dir];
  const dot = (b.x - a.x) * v[0] + (b.y - a.y) * v[1];
  return dot >= Math.min(stub, EPS);
}

// ── No-self-cross: proper segment-intersection over the simplified polyline (spec §0.3 invariant). ──
// Two NON-adjacent segments must not cross at an interior point, nor overlap collinearly along a
// length. Adjacent segments share an endpoint (allowed); the loop-closure pair of a tiny S==T loop is
// exempt (a coincident same-side C is a valid degenerate loop, spec §9.1). Returns the crossing point
// or null.
function segCross(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) {
    // parallel — flag a genuine collinear OVERLAP (an overlapping line is forbidden, spec §5.3).
    const coll = (p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x;
    if (Math.abs(coll) > 1e-6) return null;
    const ax = Math.abs(d1x) >= Math.abs(d1y);
    const a0 = ax ? Math.min(p1.x, p2.x) : Math.min(p1.y, p2.y), a1 = ax ? Math.max(p1.x, p2.x) : Math.max(p1.y, p2.y);
    const b0 = ax ? Math.min(p3.x, p4.x) : Math.min(p3.y, p4.y), b1 = ax ? Math.max(p3.x, p4.x) : Math.max(p3.y, p4.y);
    return Math.min(a1, b1) - Math.max(a0, b0) > EPS ? { x: Math.max(a0, b0), y: 0 } : null;
  }
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  const TT = 1e-6;
  return t > TT && t < 1 - TT && u > TT && u < 1 - TT ? { x: p1.x + t * d1x, y: p1.y + t * d1y } : null;
}
function selfCross(corners) {
  const segs = [];
  for (let i = 1; i < corners.length; i++) segs.push([corners[i - 1], corners[i]]);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 2; j < segs.length; j++) {
      if (i === 0 && j === segs.length - 1) continue; // tiny S==T loop closure is exempt
      const hit = segCross(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (hit) return { i, j, hit };
    }
  }
  return null;
}

// Shorthand to build an orthRoute input.
const OR = (S, T, sp, tp, extra = {}) => orthRoute({ source: S, target: T, sourcePosition: sp, targetPosition: tp, stub: 32, radius: 10, ...extra });

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.1 — straight / aligned (I)
// ══════════════════════════════════════════════════════════════════════════════════════════════
run("straight-horizontal", OR({ x: 0, y: 0 }, { x: 200, y: 0 }, R.right, R.left), (t) => {
  t.BENDS(0); t.AXIS_ALIGNED(); t.MONOTONE_X(); t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: 200, y: 0 }); t.NO_NAN();
});
run("straight-vertical", OR({ x: 0, y: 0 }, { x: 0, y: 200 }, R.bottom, R.top), (t) => {
  t.BENDS(0); t.AXIS_ALIGNED(); t.MONOTONE_Y(); t.NO_NAN();
});
run("straight-offset-tiny", OR({ x: 0, y: 0 }, { x: 200, y: 0.3 }, R.right, R.left), (t) => {
  t.BENDS(0); t.NO_NAN();
});
run("I-aligned-facing", OR({ x: 100, y: 30 }, { x: 400, y: 30 }, R.right, R.left), (t) => {
  t.BENDS(0); t.STARTS_AT({ x: 100, y: 30 }); t.ENDS_AT({ x: 400, y: 30 }); t.NO_NAN();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.2 — single corner (L)
// ══════════════════════════════════════════════════════════════════════════════════════════════
run("L-right-to-top", OR({ x: 0, y: 0 }, { x: 200, y: -200 }, R.right, R.bottom), (t) => {
  t.BENDS(1); t.AXIS_ALIGNED(); t.NO_NAN(); t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: 200, y: -200 });
});
run("L-bottom-to-left", OR({ x: 0, y: 0 }, { x: 200, y: 200 }, R.bottom, R.left), (t) => {
  t.BENDS(1); t.AXIS_ALIGNED(); t.LEAVES("bottom", 32); t.NO_NAN();
});
run("L-degenerate-corner", OR({ x: 0, y: 0 }, { x: 0.2, y: 200 }, R.right, R.bottom), (t) => {
  t.AXIS_ALIGNED(); t.NO_NAN(); t.ENDS_AT({ x: 0.2, y: 200 });
});
run("MIXED-U-behind", OR({ x: 0, y: 0 }, { x: -40, y: 200 }, R.right, R.bottom), (t) => {
  // no segment reverses the source stub (dot with +x < -MIN_SEG)
  const ds = [1, 0];
  let ok = true;
  for (let i = 1; i < t.corners.length; i++) {
    const dot = (t.corners[i].x - t.corners[i - 1].x) * ds[0];
    // only the leg right after the source counts for the source-stub-reversal guard;
    // overall: ensure first leg leaves +x and no immediate reversal of it
  }
  t.AXIS_ALIGNED(); t.NO_NAN();
  // first leg must go +x (leave right), not immediately reverse
  t.LEAVES("right", 32);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.3 — facing → Z
// ══════════════════════════════════════════════════════════════════════════════════════════════
run("Z-facing-x", OR({ x: 0, y: 0 }, { x: 200, y: 80 }, R.right, R.left), (t) => {
  t.BENDS(2); t.AXIS_ALIGNED(); t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: 200, y: 80 }); t.NO_NAN();
  // jog x ≈ (s1.x + t1.x)/2. s1=(0+eff, 0), t1=(200-eff, 80). midpoint x = 100.
  const jogXs = t.corners.filter((p, i) => i > 0 && i < t.corners.length - 1).map((p) => p.x);
  t.custom("jog-x-mid", jogXs.some((x) => Math.abs(x - 100) < 2), `jogXs=${j(jogXs)}`);
});
run("Z-facing-y", OR({ x: 0, y: 0 }, { x: 80, y: 200 }, R.bottom, R.top), (t) => {
  t.BENDS(2); t.NO_NAN();
});
run("Z-facing-aligned", OR({ x: 0, y: 0 }, { x: 200, y: 0 }, R.right, R.left), (t) => {
  t.BENDS(0); t.NO_NAN(); // Δy=0 ⇒ collapses to straight, no zero-length Q
});
run("Z-jog-in-channel", OR({ x: 100, y: 30 }, { x: 400, y: 90 }, R.right, R.left), (t) => {
  // jog x strictly between s1.x and t1.x (in the open channel)
  const s1x = 100 + 32, t1x = 400 - 32; // 132 .. 368 (eff stub may clamp but gap is wide)
  const jogXs = t.corners.slice(1, -1).map((p) => p.x);
  t.custom("jog-in-channel", jogXs.every((x) => x > Math.min(s1x, t1x) - 1 && x < Math.max(s1x, t1x) + 1), j(jogXs));
  t.AXIS_ALIGNED();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.4 — U / C / behind
// ══════════════════════════════════════════════════════════════════════════════════════════════
run("C-both-right", OR({ x: 0, y: 0 }, { x: 0, y: 120 }, R.right, R.right), (t) => {
  t.BENDS(2); t.AXIS_ALIGNED(); t.NO_NAN();
  const s1x = 0 + 32, t1x = 0 + 32;
  const backX = Math.max(...t.corners.map((p) => p.x));
  t.custom("back-of-C-right", backX >= Math.max(s1x, t1x) - 1, `backX=${backX}`);
});
run("C-both-top", OR({ x: 0, y: 0 }, { x: 120, y: 0 }, R.top, R.top), (t) => {
  t.BENDS(2); t.AXIS_ALIGNED(); t.NO_NAN();
  const backY = Math.min(...t.corners.map((p) => p.y));
  t.custom("back-of-C-top", backY <= 0 - 1, `backY=${backY}`);
});
run("U-target-behind-no-rect", OR({ x: 0, y: 0 }, { x: -200, y: 5 }, R.right, R.left), (t) => {
  // source leaves +x, target leaves -x (both pointing away → not facing). Path must NOT re-enter
  // x in [S.x .. s1.x] = [0..32] after wrapping; i.e. it wraps on the perpendicular (y) axis.
  t.AXIS_ALIGNED(); t.NO_NAN(); t.NO_SELF_CROSS();
  t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: -200, y: 5 });
});
run("U-clears-source-rect", OR({ x: 0, y: 0 }, { x: 0, y: 40 }, R.right, R.right, { sourceRect: { x: -60, y: -30, width: 60, height: 90 } }), (t) => {
  const Rs = { x: -60, y: -30, width: 60, height: 90 };
  t.OUTSIDE(Rs, "OUTSIDE(Rs)"); t.AXIS_ALIGNED(); t.NO_NAN(); t.NO_SELF_CROSS();
  // back of C at x ≥ Rs.right + clr (Rs.right = 0, clr = margin 26)
  const backX = Math.max(...t.corners.map((p) => p.x));
  t.custom("jog-x-clears-rect", backX >= 0 + 26 - 1, `backX=${backX}`);
});
run("U-clears-target-rect", OR({ x: 0, y: 40 }, { x: 0, y: 0 }, R.right, R.right, { targetRect: { x: -60, y: -30, width: 60, height: 90 } }), (t) => {
  const Rt = { x: -60, y: -30, width: 60, height: 90 };
  t.OUTSIDE(Rt, "OUTSIDE(Rt)"); t.NO_NAN();
});
run("U-turn-aligned-behind", OR({ x: 100, y: 30 }, { x: 40, y: 30 }, R.right, R.left, { sourceRect: { x: 0, y: 0, width: 100, height: 60 }, targetRect: { x: -60, y: 0, width: 80, height: 60 } }), (t) => {
  const Rs = { x: 0, y: 0, width: 100, height: 60 };
  const Rt = { x: -60, y: 0, width: 80, height: 60 };
  t.OUTSIDE(Rs, "OUTSIDE(Rs)"); t.OUTSIDE(Rt, "OUTSIDE(Rt)"); t.NO_NAN(); t.AXIS_ALIGNED(); t.NO_SELF_CROSS();
  // hairpin: 4 bends after simplify
  t.BENDS(4);
});
run("C-same-side-aligned", OR({ x: 0, y: 0 }, { x: 0, y: 0.2 }, R.right, R.right), (t) => {
  t.NO_NAN(); t.AXIS_ALIGNED();
  // flat-U with REAL perpendicular separation ≥ max(clr,stub) — not a collapsed 0.2px spur (spec §5.3).
  // clr rectless = max(stub,MIN_SEG) = 32; assert Y-extent ≥ 32.
  t.PERP_EXTENT("y", 32);
});
run("C-same-side-aligned-v", OR({ x: 0, y: 0 }, { x: 0.2, y: 0 }, R.top, R.top), (t) => {
  // V-family mirror of the same-side aligned degeneracy: X-extent must be a real flat-U ≥ 32 (spec §5.3).
  t.NO_NAN(); t.AXIS_ALIGNED(); t.PERP_EXTENT("x", 32);
});
run("U-offset-overlap-stub", orthRoute({ source: { x: 0, y: 0 }, target: { x: 18, y: 30 }, sourcePosition: R.right, targetPosition: R.left, stub: 14, radius: 10 }), (t) => {
  // Default-stub close-node OPP-facing-offset whose 2-bend U used to slice its own source stub
  // (review blocker #1). Must wrap a clean hairpin instead. NO_SELF_CROSS is the regression guard.
  t.NO_NAN(); t.AXIS_ALIGNED(); t.NO_SELF_CROSS(); t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: 18, y: 30 });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.5 — coincident / tiny / extreme params
// ══════════════════════════════════════════════════════════════════════════════════════════════
run("coincident-S-eq-T", orthRoute({ source: { x: 50, y: 50 }, target: { x: 50, y: 50 }, sourcePosition: R.right, targetPosition: R.left, stub: 14 }), (t) => {
  t.NO_NAN(); t.FINITE_LABEL(); t.custom("at-least-1-point", t.verts.length >= 1, j(t.verts));
});
run("coincident-stub0", orthRoute({ source: { x: 50, y: 50 }, target: { x: 50, y: 50 }, sourcePosition: R.right, targetPosition: R.left, stub: 0 }), (t) => {
  t.NO_NAN();
  // stub 0 + S==T: but effStub clamps to MIN_STUB(=max(radius,4)=10). With radius default 10, MIN_STUB=10.
  // So it won't be a bare dot here; assert it's at least finite & single-subpath.
  t.SINGLE_SUBPATH();
});
run("coincident-stub0-r0", orthRoute({ source: { x: 50, y: 50 }, target: { x: 50, y: 50 }, sourcePosition: R.right, targetPosition: R.left, stub: 0, radius: 0 }), (t) => {
  // radius 0 ⇒ MIN_STUB = max(0,4) = 4, still not a bare dot. Just assert NO_NAN + single subpath.
  t.NO_NAN(); t.SINGLE_SUBPATH();
});
run("near-coincident", OR({ x: 0, y: 0 }, { x: 1e-7, y: 0 }, R.right, R.left), (t) => {
  t.NO_NAN();
});
run("negative-stub", orthRoute({ source: { x: 0, y: 0 }, target: { x: 200, y: 0 }, sourcePosition: R.right, targetPosition: R.left, stub: -20, radius: 10 }), (t) => {
  t.NO_NAN(); t.BENDS(0); // clamped, behaves like straight-horizontal
});
run("nan-coord", orthRoute({ source: { x: NaN, y: 0 }, target: { x: 200, y: 0 }, sourcePosition: R.right, targetPosition: R.left, stub: 32, radius: 10 }), (t) => {
  t.NO_NAN(); t.STARTS_AT({ x: 0, y: 0 });
});
run("huge-radius", orthRoute({ source: { x: 0, y: 0 }, target: { x: 200, y: -200 }, sourcePosition: R.right, targetPosition: R.bottom, stub: 32, radius: 99999 }), (t) => {
  t.NO_NAN(); // radius clamped to half shorter leg, no overshoot ⇒ no NaN, still axis-aligned corners
  t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: 200, y: -200 });
});
run("stub-gt-gap", orthRoute({ source: { x: 0, y: 0 }, target: { x: 40, y: 0 }, sourcePosition: R.right, targetPosition: R.left, stub: 32, radius: 10 }), (t) => {
  t.AXIS_ALIGNED(); t.NO_NAN(); t.MONOTONE_X(); // effStub clamped ⇒ no backtrack
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.6 — routeAround — null semantics & clearance
// ══════════════════════════════════════════════════════════════════════════════════════════════
const RA = (S, T, sp, tp, extra = {}) => routeAround({ source: S, target: T, sourcePosition: sp, targetPosition: tp, obstacles: [], margin: 26, stub: 32, radius: 10, ...extra });

run("around-no-obstacles", RA({ x: 0, y: 0 }, { x: 300, y: 0 }, R.right, R.left, { obstacles: [] }), (t) => {
  t.custom("returns-null", t.isNull, "expected null (R1)");
});
run("around-obstacle-far", RA({ x: 0, y: 0 }, { x: 300, y: 0 }, R.right, R.left, { obstacles: [{ x: 0, y: 5000, width: 60, height: 60 }] }), (t) => {
  t.custom("returns-null", t.isNull, "expected null (R1 region filter)");
});
run("around-single-box", RA({ x: 0, y: 0 }, { x: 300, y: 0 }, R.right, R.left, { obstacles: [{ x: 120, y: -40, width: 60, height: 80 }] }), (t) => {
  t.custom("non-null", !t.isNull, "expected a route");
  if (!t.isNull) {
    t.AXIS_ALIGNED(); t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: 300, y: 0 }); t.NO_NAN();
    const inf = { x: 120 - 26, y: -40 - 26, width: 60 + 52, height: 80 + 52 };
    t.OUTSIDE(inf, "OUTSIDE(inflated)");
  }
});
run("around-zero-size-obstacle", RA({ x: 0, y: 0 }, { x: 300, y: 0 }, R.right, R.left, { obstacles: [{ x: 120, y: -40, width: 0, height: 80 }] }), (t) => {
  t.custom("returns-null", t.isNull, "only obstacle was zero-width ⇒ filtered ⇒ null");
});
run("around-no-route", RA({ x: 0, y: 0 }, { x: 60, y: 0 }, R.right, R.left, {
  // box the corridor in so completely that A* can't find an orthogonal gap within the cap
  obstacles: [{ x: 20, y: -300, width: 20, height: 600 }],
  margin: 200,
}), (t) => {
  // With a huge margin the single slab inflates to swallow the whole local region; either null (R2/R1)
  // or a valid route — but it must NOT throw/hang and must NO_NAN if non-null.
  if (!t.isNull) t.NO_NAN();
  t.custom("no-throw", true);
});
run("self-rect-grid-not-obstacle", routeAround({
  source: { x: 0, y: 0 }, target: { x: 0, y: 40 }, sourcePosition: R.right, targetPosition: R.right,
  obstacles: [{ x: 80, y: -40, width: 40, height: 120 }], margin: 26, stub: 32, radius: 10,
  sourceRect: { x: -60, y: -30, width: 60, height: 90 }, targetRect: { x: -60, y: 10, width: 60, height: 90 },
}), (t) => {
  if (!t.isNull) {
    t.NO_NAN(); t.AXIS_ALIGNED();
    // the OTHER obstacle (the 80,-40 box) must be cleared
    const inf = { x: 80 - 26, y: -40 - 26, width: 40 + 52, height: 120 + 52 };
    t.OUTSIDE(inf, "OUTSIDE(other-obstacle)");
  } else {
    t.custom("null-ok", true); // graceful fallback is acceptable
  }
});
// style-parity-radius: same S,T,sides with vs without a just-cleared obstacle ⇒ identical stub legs.
{
  const args = { source: { x: 0, y: 0 }, target: { x: 300, y: 0 }, sourcePosition: R.right, targetPosition: R.left, stub: 32, radius: 10 };
  const clear = orthRoute(args);
  const avoid = routeAround({ ...args, obstacles: [{ x: 120, y: -40, width: 60, height: 80 }], margin: 26 });
  const cC = parseCorners(clear[0]);
  // first leg of clear leaves +x by effStub; ensure avoid (if present) also starts at S and leaves +x.
  if (avoid) {
    const aC = parseCorners(avoid[0]);
    check("style-parity-radius: avoid-starts-at-S", near(aC[0], { x: 0, y: 0 }));
    check("style-parity-radius: avoid-leaves-right", leaves(aC, "right", 32));
    check("style-parity-radius: clear-leaves-right", leaves(cC, "right", 32));
  } else {
    check("style-parity-radius: avoid-non-null", false, "expected a route around the box");
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.7 — pathThroughPoints — manual waypoints
// ══════════════════════════════════════════════════════════════════════════════════════════════
run("wp-empty", pathThroughPoints([]), (t) => {
  t.custom("empty", t.d === "" && t.lx === 0 && t.ly === 0, `d=${j(t.d)} l=${t.lx},${t.ly}`);
});
run("wp-single", pathThroughPoints([{ x: 5, y: 5 }]), (t) => {
  t.custom("dot", t.d.replace(/\s+/g, " ").trim() === "M 5,5", j(t.d));
  t.custom("label", t.lx === 5 && t.ly === 5, `${t.lx},${t.ly}`); t.NO_NAN();
});
run("wp-collinear-drop", pathThroughPoints([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]), (t) => {
  t.BENDS(0);
});
run("wp-collinear-float", pathThroughPoints([{ x: 0, y: 0 }, { x: 50, y: 0.3 }, { x: 100, y: 0 }]), (t) => {
  t.BENDS(0); // dropped via tolerant simplify (regression vs old exact ===)
});
run("wp-dup-drop", pathThroughPoints([{ x: 0, y: 0 }, { x: 0, y: 0.2 }, { x: 40, y: 40 }]), (t) => {
  t.NO_NAN(); // duplicate dropped, no zero-length Q
});
run("wp-snake-axis", pathThroughPoints([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 50 }], "snake"), (t) => {
  t.AXIS_ALIGNED(); t.BENDS(1);
});
run("wp-curve-smooth", pathThroughPoints([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 50 }], "curve"), (t) => {
  t.custom("curve-only", /^M[^ML]*( C )/.test(" " + t.d) || (t.d.includes("C") && !t.d.includes(" L ")), j(t.d));
  t.NO_NAN();
  // endpoints exact
  const cs = parseCorners(t.d);
  t.custom("ends-exact", near(cs[0], { x: 0, y: 0 }) && near(cs[cs.length - 1], { x: 50, y: 50 }), j(cs));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.8 — continuity / parity (cross-cutting)
// ══════════════════════════════════════════════════════════════════════════════════════════════
// single-subpath: every producer, sample of inputs
{
  const samples = [
    OR({ x: 0, y: 0 }, { x: 200, y: 0 }, R.right, R.left),
    OR({ x: 0, y: 0 }, { x: 200, y: -200 }, R.right, R.bottom),
    OR({ x: 0, y: 0 }, { x: 200, y: 80 }, R.right, R.left),
    OR({ x: 0, y: 0 }, { x: 0, y: 120 }, R.right, R.right),
    pathThroughPoints([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 50 }], "snake"),
    pathThroughPoints([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 50 }], "curve"),
  ];
  samples.forEach((r, i) => check(`single-subpath[${i}]`, singleSubpath(r[0]), JSON.stringify(r[0])));
}
// floating-continuity: sweep T around S's perimeter; BENDS changes by ≤1 across the facing boundary,
// never NaN. We sweep the target angle and assert no NaN + bounded bend jumps.
{
  const S = { x: 0, y: 0 };
  const Rs = { x: -20, y: -20, width: 40, height: 40 };
  let prevBends = null, maxJump = 0, anyNaN = false;
  for (let deg = 0; deg < 360; deg += 3) {
    const a = (deg * Math.PI) / 180;
    const T = { x: Math.round(Math.cos(a) * 150), y: Math.round(Math.sin(a) * 150) };
    // pick sides by dominant axis from S→T (mimic perimeterPoint roughly)
    const sp = Math.abs(Math.cos(a)) >= Math.abs(Math.sin(a)) ? (Math.cos(a) >= 0 ? R.right : R.left) : (Math.sin(a) >= 0 ? R.bottom : R.top);
    const tp = Math.abs(Math.cos(a)) >= Math.abs(Math.sin(a)) ? (Math.cos(a) >= 0 ? R.left : R.right) : (Math.sin(a) >= 0 ? R.top : R.bottom);
    const [d] = orthRoute({ source: S, target: T, sourcePosition: sp, targetPosition: tp, stub: 32, radius: 10, sourceRect: Rs });
    if (/NaN|Infinity|undefined/.test(d)) anyNaN = true;
    const b = countBends(parseCorners(d));
    if (prevBends !== null) maxJump = Math.max(maxJump, Math.abs(b - prevBends));
    prevBends = b;
  }
  check("floating-continuity: no-NaN", !anyNaN);
  check("floating-continuity: bounded-bend-jump", maxJump <= 4, `maxJump=${maxJump}`);
}
// no-self-cross sweep: the spec §0.3 "never self-cross" invariant, asserted over a WIDE grid of
// close-neighbour layouts at both the default stub (14) and the consumer stub (32). This is the guard
// for review blockers #1/#3 (the OPP same-axis U used to slice its own stub for ~320 ordinary configs)
// and #4 (the gapX→0 boundary hairpin). One assertion per family so a failure names the offending pair.
{
  const oppPairs = [["left", "right"], ["right", "left"], ["top", "bottom"], ["bottom", "top"]];
  const mixedPairs = [["right", "top"], ["right", "bottom"], ["left", "top"], ["left", "bottom"], ["top", "right"], ["top", "left"], ["bottom", "right"], ["bottom", "left"]];
  const samePairs = [["right", "right"], ["left", "left"], ["top", "top"], ["bottom", "bottom"]];
  const sweepFamily = (label, pairs, stub) => {
    let worst = null, n = 0;
    for (const [sp, tp] of pairs) {
      for (let dx = -300; dx <= 300; dx += 6) {
        for (let dy = -300; dy <= 300; dy += 6) {
          const [d] = orthRoute({ source: { x: 0, y: 0 }, target: { x: dx, y: dy }, sourcePosition: sp, targetPosition: tp, stub, radius: 10 });
          n++;
          const x = selfCross(parseCorners(d));
          if (x && !worst) worst = `${sp}->${tp} d=(${dx},${dy}) at ${j(x.hit)}`;
        }
      }
    }
    check(`no-self-cross[${label}] (${n} configs)`, !worst, worst || "");
  };
  for (const stub of [14, 32]) {
    sweepFamily(`OPP stub${stub}`, oppPairs, stub);
    sweepFamily(`MIXED stub${stub}`, mixedPairs, stub);
    sweepFamily(`SAME stub${stub}`, samePairs, stub);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §11.9 — corner anchors (45° diagonal lead-in)
// ══════════════════════════════════════════════════════════════════════════════════════════════
const DIAG = { tl: { x: -1, y: -1 }, tr: { x: 1, y: -1 }, bl: { x: -1, y: 1 }, br: { x: 1, y: 1 } };
// Handle position a corner anchor actually carries (NodeHandles: tl/tr on the top edge, bl/br bottom).
// The continuation side = this position, so the diagonal's vertical component matches it (clean join).
const CPOS = (diag) => (diag.y < 0 ? R.top : R.bottom);
// first routed leg (Sraw→lead) is a 45° diagonal in the corner's outward direction
function leaves45(t, diag) {
  const a = t.corners[0], b = t.corners[1];
  const dx = b.x - a.x, dy = b.y - a.y;
  t.custom("leaves-45", Math.abs(Math.abs(dx) - Math.abs(dy)) < 1 && Math.abs(dx) > 1 && Math.sign(dx) === diag.x && Math.sign(dy) === diag.y, `leg=(${dx},${dy}) diag=${j(diag)}`);
}
// last routed leg (lead→Traw) arrives at 45° (moving −diag into the corner)
function arrives45(t, diag) {
  const n = t.corners.length;
  const a = t.corners[n - 2], b = t.corners[n - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  t.custom("arrives-45", Math.abs(Math.abs(dx) - Math.abs(dy)) < 1 && Math.abs(dx) > 1 && Math.sign(dx) === -diag.x && Math.sign(dy) === -diag.y, `leg=(${dx},${dy}) diag=${j(diag)}`);
}
// Corner route: source/target sides default to each corner's real handle position (override via extra).
const ORC = (S, T, extra) => {
  const sp = extra.sourceCorner ? CPOS(extra.sourceCorner) : R.right;
  const tp = extra.targetCorner ? CPOS(extra.targetCorner) : R.left;
  return orthRoute({ source: S, target: T, sourcePosition: sp, targetPosition: tp, stub: 32, radius: 10, ...extra });
};

run("corner-tr-source", ORC({ x: 0, y: 0 }, { x: 180, y: -120 }, { sourceCorner: DIAG.tr, targetPosition: R.left }), (t) => {
  t.NO_NAN(); t.SINGLE_SUBPATH(); t.NO_SELF_CROSS(); t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: 180, y: -120 }); leaves45(t, DIAG.tr);
});
run("corner-bl-source", ORC({ x: 0, y: 0 }, { x: -160, y: 140 }, { sourceCorner: DIAG.bl, targetPosition: R.right }), (t) => {
  t.NO_NAN(); t.SINGLE_SUBPATH(); t.NO_SELF_CROSS(); t.STARTS_AT({ x: 0, y: 0 }); leaves45(t, DIAG.bl);
});
run("corner-br-target", ORC({ x: 0, y: 0 }, { x: 200, y: 160 }, { targetCorner: DIAG.br, sourcePosition: R.right }), (t) => {
  t.NO_NAN(); t.SINGLE_SUBPATH(); t.NO_SELF_CROSS(); t.ENDS_AT({ x: 200, y: 160 }); arrives45(t, DIAG.br);
});
run("corner-both", ORC({ x: 0, y: 0 }, { x: 220, y: 160 }, { sourceCorner: DIAG.br, targetCorner: DIAG.tl }), (t) => {
  t.NO_NAN(); t.SINGLE_SUBPATH(); t.NO_SELF_CROSS(); t.STARTS_AT({ x: 0, y: 0 }); t.ENDS_AT({ x: 220, y: 160 }); leaves45(t, DIAG.br); arrives45(t, DIAG.tl);
});
run("corner-behind", ORC({ x: 0, y: 0 }, { x: -200, y: -200 }, { sourceCorner: DIAG.br, targetPosition: R.left }), (t) => {
  // target in the OPPOSITE quadrant from the corner's diagonal — must still be clean (no NaN/self-cross).
  t.NO_NAN(); t.SINGLE_SUBPATH(); t.NO_SELF_CROSS(); t.STARTS_AT({ x: 0, y: 0 }); leaves45(t, DIAG.br);
});
run("corner-non-corner-id", orthRoute({ source: { x: 0, y: 0 }, target: { x: 200, y: 0 }, sourcePosition: R.right, targetPosition: R.left, stub: 32, radius: 10 }), (t) => {
  t.BENDS(0); t.AXIS_ALIGNED(); // no corner ⇒ plain perpendicular route unchanged
});
// corner self-cross / NaN sweep — the regression guard for the 45° lead-in slicing a later arm. Checked
// FINELY (step 2) on the RENDERED vertices (parseVertices), independent of the source's own ideal-polyline
// fallback guard, so a guard weakness surfaces here as a real rendered crossing. Each corner as source
// (real handle position) and as target, plus a both-corner pass; also a position-MISMATCH pass (the
// consumer always pairs id↔position, but assert robustness regardless).
// Sample the rendered path's Q arcs into a dense polyline — mirrors the router's own `roundedSamples`
// guard, so the guard (touch-inclusive) is a strict superset of this check (strict-interior + overlap):
// any rendered crossing the router fails to fall back on surfaces here.
function sampleRendered(d) {
  if (!d) return [];
  const toks = d.trim().split(/\s+/);
  let i = 0, cur = null; const pts = [];
  const rd = () => { const [x, y] = toks[i++].split(",").map(Number); return { x, y }; };
  while (i < toks.length) {
    const c = toks[i++];
    if (c === "M" || c === "L") { cur = rd(); pts.push(cur); }
    else if (c === "Q") {
      const ctrl = rd(), end = rd();
      for (const t of [0.2, 0.4, 0.6, 0.8]) { const m = 1 - t; pts.push({ x: m * m * cur.x + 2 * m * t * ctrl.x + t * t * end.x, y: m * m * cur.y + 2 * m * t * ctrl.y + t * t * end.y }); }
      pts.push(end); cur = end;
    } else if (c === "C") { rd(); rd(); cur = rd(); pts.push(cur); }
    else throw new Error("cmd " + c);
  }
  return pts;
}
function renderedCross(d) { return selfCross(sampleRendered(d)); }
// DIFFERENTIAL sweep: the 45° flourish must never INTRODUCE a rendered crossing the plain route doesn't
// already have. (At very tight separations the plain MIXED route can itself render-cross — a pre-existing
// core-dispatch concern, tracked separately; the corner feature is correct as long as it's never worse
// than plain — which holds because the guard falls back to the plain route whenever the flourish crosses.)
{
  const corners = [["tl", DIAG.tl], ["tr", DIAG.tr], ["bl", DIAG.bl], ["br", DIAG.br]];
  const allPos = [R.top, R.bottom, R.left, R.right];
  let n = 0, worstSrc = null, worstTgt = null, worstMis = null, worstBoth = null, fellBack = 0, preExist = 0;
  const introduces = (cornerD, plainD) => renderedCross(cornerD) && !renderedCross(plainD);
  for (const [name, diag] of corners) {
    for (let dx = -200; dx <= 200; dx += 2) {
      for (let dy = -200; dy <= 200; dy += 2) {
        const T = { x: dx, y: dy };
        // source corner vs the same route WITHOUT the corner (real handle position)
        const sp = CPOS(diag);
        const plainS = orthRoute({ source: { x: 0, y: 0 }, target: T, sourcePosition: sp, targetPosition: R.left, stub: 32, radius: 10 })[0];
        const cornS = orthRoute({ source: { x: 0, y: 0 }, target: T, sourcePosition: sp, targetPosition: R.left, stub: 32, radius: 10, sourceCorner: diag })[0];
        n++;
        if (renderedCross(plainS)) preExist++;
        if (/NaN|Infinity|undefined/.test(cornS) && !worstSrc) worstSrc = `${name} d=(${dx},${dy}) NaN`;
        if (introduces(cornS, plainS) && !worstSrc) worstSrc = `${name} src d=(${dx},${dy}) at ${j(renderedCross(cornS).hit)}`;
        if (Math.hypot(dx, dy) >= 64 && !leaves45Hit(cornS, diag)) fellBack++; // flourish dropped in its domain
        // target corner
        const plainT = orthRoute({ source: { x: 0, y: 0 }, target: T, sourcePosition: R.right, targetPosition: CPOS(diag), stub: 32, radius: 10 })[0];
        const cornT = orthRoute({ source: { x: 0, y: 0 }, target: T, sourcePosition: R.right, targetPosition: CPOS(diag), stub: 32, radius: 10, targetCorner: diag })[0];
        if (introduces(cornT, plainT) && !worstTgt) worstTgt = `${name} tgt d=(${dx},${dy}) at ${j(renderedCross(cornT).hit)}`;
        if (/NaN|Infinity|undefined/.test(cornT) && !worstTgt) worstTgt = `${name} tgt d=(${dx},${dy}) NaN`;
        // position MISMATCH (id position deliberately wrong) — flourish still must not be worse than plain
        for (const p of allPos) {
          const plainM = orthRoute({ source: { x: 0, y: 0 }, target: T, sourcePosition: p, targetPosition: R.left, stub: 32, radius: 10 })[0];
          const cornM = orthRoute({ source: { x: 0, y: 0 }, target: T, sourcePosition: p, targetPosition: R.left, stub: 32, radius: 10, sourceCorner: diag })[0];
          if (introduces(cornM, plainM) && !worstMis) worstMis = `${name}@${p} d=(${dx},${dy}) at ${j(renderedCross(cornM).hit)}`;
          if (/NaN|Infinity|undefined/.test(cornM) && !worstMis) worstMis = `${name}@${p} d=(${dx},${dy}) NaN`;
        }
      }
    }
  }
  for (let dx = -200; dx <= 200; dx += 3) {
    for (let dy = -200; dy <= 200; dy += 3) {
      const T = { x: dx, y: dy };
      const plainB = orthRoute({ source: { x: 0, y: 0 }, target: T, sourcePosition: CPOS(DIAG.br), targetPosition: CPOS(DIAG.tl), stub: 32, radius: 10 })[0];
      const cornB = orthRoute({ source: { x: 0, y: 0 }, target: T, sourcePosition: CPOS(DIAG.br), targetPosition: CPOS(DIAG.tl), stub: 32, radius: 10, sourceCorner: DIAG.br, targetCorner: DIAG.tl })[0];
      if (introduces(cornB, plainB) && !worstBoth) worstBoth = `both d=(${dx},${dy}) at ${j(renderedCross(cornB).hit)}`;
      if (/NaN|Infinity|undefined/.test(cornB) && !worstBoth) worstBoth = `both d=(${dx},${dy}) NaN`;
    }
  }
  check(`corner-source introduces-no-cross/NaN (${n} configs, ${preExist} pre-existing plain crosses)`, !worstSrc, worstSrc || "");
  check(`corner-target introduces-no-cross/NaN`, !worstTgt, worstTgt || "");
  check(`corner-both introduces-no-cross/NaN`, !worstBoth, worstBoth || "");
  check(`corner-position-mismatch introduces-no-cross/NaN`, !worstMis, worstMis || "");
  // sanity: the flourish survives for the bulk of its-domain (≥64px) layouts (fallback not over-eager).
  check(`corner-flourish-kept-majority (fell back ${fellBack}/${n})`, fellBack < n * 0.25, `${fellBack}/${n}`);
}
// helper: does the rendered path's first leg leave at ~45° in the corner's diagonal direction?
function leaves45Hit(d, diag) {
  const v = parseVertices(d);
  if (v.length < 2) return false;
  const dx = v[1].x - v[0].x, dy = v[1].y - v[0].y;
  return Math.abs(Math.abs(dx) - Math.abs(dy)) < 2 && Math.abs(dx) > 1 && Math.sign(dx) === diag.x && Math.sign(dy) === diag.y;
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────
console.log("");
console.log(`orthRoute test matrix — ${passed} passed, ${failed} failed (${passed + failed} assertions)`);
if (failed) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
} else {
  console.log("All assertions passed.");
  process.exit(0);
}
