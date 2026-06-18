// Self-check for line-jump path post-processing. Run: npx tsx scripts/test-linejumps.mjs
import { applyJumps } from "../app/(editor)/boards/[id]/_components/edges/lineJumps.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}`); } };

// Pull every "x,y" coordinate pair out of an SVG path string, in order.
const coords = (d) => [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

// A line heading LEFT (target at the left), crossing in the middle → it hops.
const pts = [{ x: 500, y: 0 }, { x: 400, y: 0 }, { x: 300, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 0 }];
for (const style of ["arc", "gap"]) {
  const d = applyJumps(pts, [{ dist: 200 }], style, 14);
  const c = coords(d);
  ok(`${style}: ends at the target endpoint (100,0)`, same(c[c.length - 1], [100, 0]));
  // The bug: a duplicated endpoint left a zero-length final segment → degenerate arrowhead tangent.
  ok(`${style}: final segment is non-degenerate (no duplicated endpoint)`, !same(c[c.length - 1], c[c.length - 2]));
  // Sanity: the endpoint must not be duplicated anywhere mid-path either.
  ok(`${style}: endpoint appears exactly once`, c.filter((p) => same(p, [100, 0])).length === 1);
}

// No crossings → plain polyline, still ends correctly with a clean final segment.
{
  const d = applyJumps(pts, [], "arc", 14);
  const c = coords(d);
  ok("no-crossings: ends at (100,0)", same(c[c.length - 1], [100, 0]));
  ok("no-crossings: non-degenerate final segment", !same(c[c.length - 1], c[c.length - 2]));
}

console.log(`\nlineJumps — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
