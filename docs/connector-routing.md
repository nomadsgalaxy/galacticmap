# Orthogonal Connector Routing — Canonical Specification

> **Provenance.** This specification was derived independently from the public,
> well-known orthogonal / Manhattan connector-routing algorithm (perpendicular
> stub exits, minimal-bend L / Z / U joins, an interval-grid A\* with a turn
> penalty for obstacle avoidance) and from first principles of plane geometry.
> It was **not** derived from, and does not reproduce, draw.io / mxGraph source
> code. References to "the draw.io look" describe a visual goal (clean
> right-angle connectors), not a code lineage. This document and the
> implementation it governs are published under the **OpenCommunityLicense** as
> original work.

This is the single source of truth for the orthogonal connector router. It
merges three independent spec drafts (case geometry, obstacle avoidance / style
parity, degenerate cases / numerics / API) into one de-duplicated,
implementation-ready document. The implementation and the verifier both consume
the **Test Matrix** in §11.

Files governed:

- `app/(editor)/boards/[id]/_components/edges/orthogonalRoute.ts` — the router
  (`orthRoute`, `routeAround`, `pathThroughPoints`, `roundedPath`, `curvedPath`,
  `simplify`, `labelAnchor`). This is what we are hardening.
- `app/(editor)/boards/[id]/_components/edges/AnimatedEdge.tsx` — the consumer.
  Only the `routed` `useMemo` (≈ lines 173–185) may change, and only to pass the
  new optional rects. The line-jump / comet / render region (≈ lines 200+) is
  **off-limits**.

---

## 0. Scope, symbols, invariants

### 0.1 Types

```
Pt   = { x: number; y: number }
Rect = { x: number; y: number; width: number; height: number }   // top-left origin, +x right, +y down
Position = "left" | "right" | "top" | "bottom"                    // @xyflow/react
RouteResult = [pathD: string, labelX: number, labelY: number]
```

Side unit vectors: `left=(-1,0)`, `right=(1,0)`, `top=(0,-1)`, `bottom=(0,1)`.
`rectRight = R.x+R.width`, `rectBottom = R.y+R.height`.

### 0.2 Symbols

| Symbol | Meaning |
|---|---|
| `S`, `T` | source / target endpoint (point on node perimeter) |
| `ds`, `dt` | source / target leave direction = `leaveDir(position)`, an axis unit vector |
| `stub` | perpendicular approach length. Module default `14`; consumer passes `APPROACH_BUFFER = ARROW_WIDTH*2 = 32` |
| `s1`, `t1` | stub ends: `s1 = S + ds*effStub_s`, `t1 = T + dt*effStub_t` |
| `r` / `radius` | corner radius. Default `10` in both routers |
| `margin` | obstacle clearance. Default `OBSTACLE_MARGIN = 26` |
| `Rs`, `Rt` | **optional** source / target node rects (new params, U-turn self-clearance) |
| `hs`, `ht` | `ds.x !== 0` / `dt.x !== 0` — does each end leave **horizontally** |

### 0.3 Hard invariants (hold for every emitted path)

1. **Stub bracketing.** The polyline always begins `[S, s1, …]` and ends
   `[…, t1, T]`. Each endpoint leaves perpendicular to its side and travels its
   stub straight before any turn, so arrowheads sit flush at a right angle.
2. **Axis-aligned interior.** Every interior segment of a `snake` path is purely
   horizontal or vertical. No diagonals anywhere. (`curve` style is the sole
   exception; its control arms may bulge off-axis by design.)
3. **One continuous subpath.** `pathD` is exactly one `M`, then `L`/`Q` (snake)
   or `C` (curve). Never a second `M`, never `Z`, never `A`. The comet in
   `AnimatedEdge` animates a stroke-dash along this single subpath; a second `M`
   would spawn a second comet head. Line-jumps are applied downstream on a
   resampled copy and may add gaps — the producers here never do.
4. **Simplify then round.** Every producer routes its polyline through the one
   tolerant `simplify` (§3.2) before `roundedPath` / `curvedPath`. After
   simplify no two consecutive points are within `EPS_COLLINEAR`, so
   `roundedPath` never sees a zero-length segment.
5. **Total & finite.** `orthRoute` and `pathThroughPoints` never return `null`,
   never throw, and never emit `NaN` / `Infinity` / `undefined` in `pathD`.
   `routeAround` may return `null` (a fallback sentinel, §2.3) but never throws
   or emits non-finite text.
6. **Style parity.** The clear router (`orthRoute`) and the obstacle router
   (`routeAround`) emit the same visual vocabulary — same stub policy, same
   radius (`10`), same single continuous subpath — so an edge never visibly
   snaps shape as a node slides into or out of the way.

### 0.4 The four canonical shapes

| Shape | Bends | When |
|---|---|---|
| **I** straight | 0 | same axis, stubs collinear and facing (aligned) |
| **L** single corner | 1 | mixed axes (one end H-leaving, one V-leaving) |
| **Z** mid-jog | 2 | same axis, stubs face each other, offset on the cross axis |
| **U / C** wrap | 2 (–4) | same axis, stubs do **not** face (target behind source, or same-side) |

`routeAround` produces these same shapes; an obstacle detour is a U or Z with
extra collinear-stripped corners, never a diagonal and never a Bézier (except in
explicit `curve` style).

---

## 1. Function contract

### 1.1 `orthRoute` — clear router (total, never null)

```ts
orthRoute(input: {
  source: Pt; target: Pt;
  sourcePosition: Position; targetPosition: Position;
  stub?: number;       // default 14
  radius?: number;     // default 10
  sourceRect?: Rect;   // NEW, optional — source node box, for U-turn self-clearance
  targetRect?: Rect;   // NEW, optional — target node box, for U-turn self-clearance
}): RouteResult        // never null, never throws, never NaN
```

- **Total.** For any finite input it returns a valid `RouteResult`.
- `sourceRect` / `targetRect` are **optional and additive**. When omitted,
  behavior equals today's `orthRoute` *except* for the degenerate hardening in
  §4–§5 (observable only on inputs that are already broken today). Existing
  callers that pass neither rect keep working.
- When rects are present, `orthRoute` MAY widen a **U / C** jog so it clears its
  own node box (§5). It MUST NOT use the rects for general obstacle avoidance —
  that is `routeAround`'s job. The only sanctioned use is "don't cut back through
  *my own* source/target box."
- `stub` and `radius` are sanitized (§3.3) before use.

### 1.2 `routeAround` — obstacle router (nullable)

```ts
routeAround(input: {
  source: Pt; target: Pt;
  sourcePosition: Position; targetPosition: Position;
  obstacles: Rect[];
  margin?: number;     // default 26
  stub?: number;       // default 14
  radius?: number;     // NEW, optional — default 10; MUST match the clear route's radius
  style?: "snake" | "curve";   // default "snake"
  sourceRect?: Rect;   // NEW, optional — self-clearance grid lines (NOT obstacles), §7.3
  targetRect?: Rect;
}): RouteResult | null
```

`null` is a sentinel meaning **"caller should fall back to `orthRoute`."** It is
returned in exactly these cases and no others:

| # | Condition | Meaning |
|---|---|---|
| R1 | after region-filtering, `obstacles.length === 0` | nothing to avoid; clear router is prettier |
| R2 | A\* hits the iteration cap or never pops `goal` | no orthogonal route on the sparse grid |
| R3 | stub-tip grid index `s0`/`t0` missing after rounding | stub fell off the constructed grid |

`null` is never an error signal. Malformed input is sanitized first (§3) so
`routeAround` returns either a valid path or a clean `null`.

### 1.3 `pathThroughPoints` — manual waypoints (total, never null)

```ts
pathThroughPoints(points: Pt[], style: "snake" | "curve" = "snake"): RouteResult
```

- `points.length === 0` → `["", 0, 0]`.
- `points.length === 1` → `["M x,y", x, y]` (degenerate dot; renders nothing).
- `points.length >= 2` → normal path.
- Collinear / duplicate midpoints are dropped via the **unified** `simplify`
  (§3.2), NOT exact `===`. (Today this function uses exact equality — a weak
  spot: user-dragged waypoints rarely land on exact integers, so collinear runs
  slip through and `roundedPath` rounds a near-zero segment. Fixed here.)

### 1.4 Purity

All producers are pure: identical inputs → byte-identical `pathD`. No `Date`, no
RNG, no global state, no input mutation. `routeAround`'s A\* uses a deterministic
linear min-`f` scan with first-index tie-break (§9), so its output is stable for
snapshot tests.

---

## 2. Router selection (consumer contract)

The single decision point is `AnimatedEdge`'s `routed` `useMemo` (≈ lines
173–185). It is the ONLY region of `AnimatedEdge` that may change, and only to
pass the optional rects.

```
decide(a, b, sPos, tPos, obstacles, margin, stub, Rs, Rt):
  if routing != "avoid" or waypoints.length > 0:  return null   // handled elsewhere
  blocked = obstacles.length > 0
            && blockingRects(a, b, obstacles, margin).length > 0
  if blocked:
      r = routeAround({ source:a, target:b, sourcePosition:sPos, targetPosition:tPos,
                        obstacles, margin, stub, radius:10, style,
                        sourceRect:Rs, targetRect:Rt })
      if r != null: return r
  return orthRoute({ source:a, target:b, sourcePosition:sPos, targetPosition:tPos,
                     stub, radius:10, sourceRect:Rs, targetRect:Rt })
```

`Rs`/`Rt` are taken from the existing `ends` store entry for floating edges
(`ends.src` / `ends.tgt`), or built from the node lookup for fixed edges; pass
`undefined` when unavailable. **Nothing outside the `routed` useMemo changes.**

### 2.1 Selection table

| obstacles near line? | `blockingRects` non-empty? | `routeAround` | path used |
|---|---|---|---|
| no | — | — | `orthRoute` (clear) |
| yes | no (line misses every inflated rect) | — | `orthRoute` (clear) |
| yes | yes | non-null | `routeAround` (avoid) |
| yes | yes | **null** | `orthRoute` (clear) — graceful fallback |

`blockingRects` tests the *straight* `a→b` segment against each obstacle
inflated by `margin` (`segCrossesRect` after `inflate`). It is the only trigger;
it is a cheap proxy (if even the diagonal shortcut clears all inflated rects, the
boxier orthogonal clear path is assumed clear too). The residual risk — an
orthogonal bulge into a rect the diagonal missed — is mitigated by style parity
(§6), which makes any resulting flip visually invisible. No temporal hysteresis
is added.

---

## 3. Numerics & sanitization

### 3.1 Tolerance constants (single source of truth)

```
EPS_COINCIDENT = 1e-6   // two coords are "the same point"
EPS_COLLINEAR  = 0.5    // drop a near-duplicate / near-collinear midpoint (matches simplify today)
EPS_FACING     = 1e-9   // sign test for "stubs face each other"
ALIGN_EPS      = 0.5    // cross-axis offset below this ⇒ "aligned" (unified with EPS_COLLINEAR)
MIN_SEG        = 0.5    // shortest segment we will emit
MIN_STUB       = max(radius, 4)
```

> **Resolved contradiction.** Draft 1 used `ALIGN_EPS = 1px`; Drafts 2/3 used
> the simplify tolerance `0.5`. We standardize on **`0.5`** for both
> `ALIGN_EPS` and the collinear test so the "aligned" branch decision and the
> simplify dedupe agree exactly — a point that simplify would collapse is
> precisely a point the aligned test treats as on-axis. This removes a class of
> "decided Z but simplify made it I" mismatches.

### 3.2 Unified collinearity / dedupe (`simplify`)

There is **one** `simplify(pts)` used by `orthRoute`, `routeAround`, and
`pathThroughPoints`. (Today there are three near-duplicate filters — two exact
`===`, one tolerant; collapse them to the tolerant one.) First and last points
always survive. A midpoint `c` between kept `p` and lookahead `n` is dropped when
**either**:

- **Duplicate:** `|p.x−c.x| < EPS_COLLINEAR && |p.y−c.y| < EPS_COLLINEAR`, or
- **Collinear axis-aligned:**
  `(|p.x−c.x| < EPS_COLLINEAR && |c.x−n.x| < EPS_COLLINEAR)` (vertical run) **or**
  `(|p.y−c.y| < EPS_COLLINEAR && |c.y−n.y| < EPS_COLLINEAR)` (horizontal run).

After `simplify`, length ≥ 1; if input length ≥ 2, length ≥ 2 (endpoints survive
even when coincident).

### 3.3 Parameter & coordinate sanitization (anti-NaN firewall)

```
finite(v, d) = Number.isFinite(v) ? v : d
num(v)       = Number.isFinite(v) ? v : 0
stub'   = clamp(finite(stub,   14), 0, +∞)   // negative → 0 (would point into the node)
radius' = clamp(finite(radius, 10), 0, +∞)
margin' = clamp(finite(margin, 26), 0, +∞)
```

Every input coordinate passes through `num()` at the top of every producer. A
single `NaN` endpoint (e.g. an unmeasured node) otherwise propagates into `lerp`
→ `hypot(NaN)` → a `NaN` path string → SVG drops the whole edge. Coercing to `0`
yields a visibly-wrong-but-finite line, which is debuggable.

### 3.4 Grid rounding (`routeAround` only)

Grid lines are built and looked up with `Math.round` (`uniqSorted`). The rounded
stub-tip coordinate MUST be present in the rounded grid axis; if the lookup
misses, return `null` (R3) rather than indexing `undefined` (which would later
produce `NaN`). Because the same rounding is used for both construction and
lookup, near-duplicate float lines collapse consistently.

---

## 4. The 4×4 side-pair matrix and dispatch

The 16 ordered `(sourceSide, targetSide)` pairs collapse into three families by
axis parity:

```
            target →   Right    Left     Top      Bottom
 source ↓
   Right              SAME-H   OPP-H    MIXED    MIXED
   Left               OPP-H    SAME-H   MIXED    MIXED
   Top                MIXED    MIXED    SAME-V   OPP-V
   Bottom             MIXED    MIXED    OPP-V    SAME-V
```

- **MIXED** (8 pairs): `hs != ht` → **L** (one corner), with **U** fallback when
  the corner would reverse a stub (§4.3).
- **OPP-H / OPP-V** (4 pairs): same axis, opposite leave directions → **I / Z /
  U** by the relative-position class (§4.4).
- **SAME-H / SAME-V** (4 pairs): same axis, identical leave directions, never
  facing → **C** (§4.5).

### 4.1 Relative-position classes (same-axis selector)

Computed on the **stub ends** `s1`/`t1` (not raw endpoints — using stub ends is
what keeps the route leaving the node first). For the H families (travel axis X,
offset axis Y; mirror for V):

```
gapX    = t1.x - s1.x
offY    = t1.y - s1.y
aligned = |offY| < ALIGN_EPS                         // stub ends share a horizontal line
facing  = ds.x*gapX > EPS_FACING && dt.x*(-gapX) > EPS_FACING
```

> **Resolved bug (the headline I-vs-U fix).** Today `facing` uses strict `>` on
> `gapX`, and "aligned" is never separated. When `t1.x == s1.x` exactly (stubs
> collinear, facing), today's test is `ds.x*0 > 0` = false, so a perfectly
> aligned facing pair wrongly takes the U branch and draws a backward jog. The
> spec evaluates **`aligned` first**: an aligned same-axis opposite-direction
> pair emits **I** (0 bends). The `EPS_FACING` sign test then keeps
> exactly-collinear-but-offset facing as "facing."

| Class | Condition (H family) | Shape | Bends |
|---|---|---|---|
| Aligned (opp dirs) | opposite dirs, `aligned` | **I** | 0 |
| Facing + offset | `facing && !aligned` | **Z** | 2 |
| Behind + offset | opposite dirs, `!facing && !aligned` | **U** | 2 |
| Behind + aligned | opposite dirs, `!facing && aligned` | **U** (hairpin) | 4 |
| Same-side (any) | identical dirs | **C** | 2 |

### 4.2 Master dispatch (flat, implementable)

```
SAME_AXIS = (hs == ht)

if !SAME_AXIS:                                   # MIXED
    C = canonicalCorner(ds, dt, s1, t1)         # §4.3
    if reverses(s1, C, ds) or reverses(C, t1, dt):
        emit MIXED_U(s1, t1, ds, dt, clr)       # §4.3
    else:
        emit L([S, s1, C, t1, T])               # 1 bend

else:                                            # same axis
    sameDir = (ds == dt)
    aligned = |perpOffset(s1, t1)| < ALIGN_EPS
    facing  = stubsFaceEachOther(ds, dt, s1, t1)

    if sameDir:                  emit C_clamp(...)            # §4.5  → C (2 bends)
    elif aligned:                emit I([S, s1, t1, T])       # §4.4.1 → I (0 bends)
    elif facing:                 emit Z(midGap(s1, t1))       # §4.4.2 → Z (2 bends)
    else:                        emit U_offset(s1, t1, clr,   # §4.4.3 / §5
                                              Rs, Rt)         #        → U (2–4 bends)
```

Helpers:
- `canonicalCorner(ds,dt,s1,t1) = hs ? {x:t1.x, y:s1.y} : {x:s1.x, y:t1.y}`.
- `reverses(a,b,dir)` = segment `a→b` has a component opposite `dir` on `dir`'s
  axis (`dot(b−a, dir) < -MIN_SEG`).
- `clr` = clearance for self-jogs = `margin` when rects present, else `stub`.

### 4.3 MIXED — L corner, with U fallback

One end H-leaving, one V-leaving. The single connecting corner is
`canonicalCorner`: `hs` (source horizontal) → `C = {x:t1.x, y:s1.y}`; `ht`
(target horizontal) → `C = {x:s1.x, y:t1.y}`. Polyline `[S, s1, C, t1, T]`
simplifies to the **L** (1 bend).

The corner is wrong when it forces a stub to immediately reverse (target tucked
"behind" on the perpendicular axis). Detect with `reverses`; then emit a shallow
**MIXED-U** that pushes out along the leave axis past the obstruction, drops to
the other row, and runs in (source H-leaving, target V-leaving below source):

```
mx  = (ds.x > 0) ? max(s1.x, t1.x) + 0 : min(s1.x, t1.x)
      // if that still keeps s1→mx in +ds.x, use it; else mx = s1.x + ds.x*stub
pts = [S, s1, {x:mx, y:s1.y}, {x:mx, y:t1.y}, t1, T]   // 1–2 bends after simplify
```

This keeps MIXED in the L / shallow-Z vocabulary and never re-enters a node.

### 4.4 OPP — I / Z / U

#### 4.4.1 Aligned → I (0 bends)

Opposite dirs, `aligned`. Stubs lie on one line, pointing at each other. Emit
`[S, s1, t1, T]`; simplify collapses to `M S L T`. *(Today's code mis-draws this
as a U — fixed.)*

#### 4.4.2 Facing + offset → Z (2 bends)

`facing && !aligned`. Jog across the **midpoint of the facing gap on the travel
axis** (between the stub ends, NOT between the raw endpoints — this guarantees
the jog sits in the open channel between the nodes, never on a node face):

```
H family:  mx = (s1.x + t1.x)/2 ; pts = [S, s1, {mx,s1.y}, {mx,t1.y}, t1, T]
V family:  my = (s1.y + t1.y)/2 ; pts = [S, s1, {s1.x,my}, {t1.x,my}, t1, T]
```

#### 4.4.3 Behind / not facing → U (2 bends, rect-cleared)

Opposite dirs, `!facing`, `!aligned` (target is behind source). The path wraps on
the **perpendicular** axis. The jog line must clear both node boxes — see §5,
which supersedes the naive midpoint `(s1.y+t1.y)/2` that causes the
U-turn-through-the-box bug.

### 4.5 SAME — C (2 bends)

Identical leave directions, never facing. Both stubs travel the same way, so the
connector exits, runs parallel, and comes back — a **C**:

```
H family (both leaving Right):  outX = max(s1.x, t1.x)              [rectless]
                                outX = max(s1.x, t1.x, Rs.right, Rt.right) + clr   [rect-aware]
pts = [S, s1, {outX, s1.y}, {outX, t1.y}, t1, T]
```

For both-Left use `min(...) − clr`; mirror for V. Choose the leave-direction
side; pick the shallower wrap when rects are present (§5.1).

---

## 5. U / C self-clearance (weak spot #1) — the optional rects

When the cross-axis jog of a **U** (§4.4.3) or the return leg of a **C** (§4.5)
passes through the interior of the source or target box, it must be pushed to the
far side. Today `orthRoute` has no rects, so it jogs at the midpoint and can cut
through its own node. The optional `sourceRect`/`targetRect` fix this.

### 5.1 Clearance rule (rect-aware)

`clr = margin` when rects present (falling back to `stub` when absent). For an
H-family back-jog whose jog line is the **Y** coordinate `my`, the jog must clear
both boxes' Y spans; choose the **closer** side so the U stays shallow:

```
topClear    = min(Rs.y, Rt.y) - clr
bottomClear = max(Rs.bottom, Rt.bottom) + clr
natural     = (s1.y + t1.y)/2
my = (|natural - topClear| <= |natural - bottomClear|) ? topClear : bottomClear
pts = [S, s1, {s1.x, my}, {t1.x, my}, t1, T]            # 2 bends
```

Equivalently, the "outside both stub tips and both boxes" form (Drafts 2/3):
`my = (ds.y>0 ? max(s1.y,t1.y,Rs.bottom,Rt.bottom)+stub : min(...)−stub)` is an
acceptable degenerate-safe fallback when only one side has room; the closer-side
rule above is preferred for shallowness when both rects are present.

### 5.2 Aligned-behind (pure 180° U-turn) → U hairpin (4 bends)

Opposite dirs, `!facing && aligned` (both stubs on one row, pointing apart).
There is no cross-axis offset to exploit, so the U must go **out** and **back**:

```
H family, both leaving Right, T behind S:
  outX = max(Rs.right, Rt.right) + clr            // far side on the leave axis
  my   = chosen per §5.1                           // clear on the perpendicular axis
  pts  = [S, s1, {outX, s1.y}, {outX, my}, {t-side-x, my}, {t-side-x, t1.y}, t1, T]
```

After simplify this is a tidy squared-off **U** that clears both boxes.

### 5.3 Same-side aligned degeneracy (weak spot #2)

In a **C** where `|offY| < ALIGN_EPS` (both endpoints share the row and side),
the two parallel legs collapse onto one line and the back of the C would be a
zero-length / overlapping spur. **Rule:** synthesize a perpendicular separation
of `max(clr, stub)` for the two legs (force `t1.y = s1.y ± max(clr,stub)` for the
jog construction) so the C has nonzero height. The result is a visible flat-U,
never an overlapping line. `simplify` removes any residual float-noise micro-leg.

### 5.4 Absent rects (back-compat)

When `Rs`/`Rt` are absent or zero-area, `clr = stub` and the jog uses the
"outside both stub tips" form: `jogX/jogY = (dir>0 ? max(s1,t1)+stub :
min(s1,t1)−stub)`. This guarantees the jog is beyond both stub ends so it cannot
re-enter a node along the leave axis — strictly better than today's midpoint, and
the only behavior available without rects. A zero-area rect contributes nothing
to the `max`/`min` (`rectRight = R.x`, etc.), so the formula stays total:
`rRight(R) = R ? R.x+R.width : -∞` (and `+∞` in the `min` branch).

---

## 6. Style parity (`orthRoute` ↔ `routeAround`)

An edge must never visibly change shape family as a node moves in or out of its
path. The two routers run different algorithms; parity is enforced on outputs:

1. **Same renderer & radius.** Both terminate in `roundedPath(pts, 10)` (or
   `curvedPath` for `curve` style). `routeAround` MUST receive the same `radius`
   the clear route used (new `radius` param; default `10`). Each corner radius is
   clamped to half the shorter adjacent leg.
2. **Same stub.** Both compute `s1 = S + ds*effStub`, `t1 = T + dt*effStub`, and
   both use the **clamped effective stub** (§4 / §8). `routeAround` seeds A\* at
   the stub tips, so its first/last legs match `orthRoute`'s stubs exactly. When
   an obstacle clears and selection falls back to `orthRoute`, the stub geometry
   is byte-identical — no endpoint twitch.
3. **Convergence across the flip.** As the only blocking rect stops intersecting
   the `s1→t1` corridor, its obstacle edges no longer constrain any A\* move, the
   minimal-bend solution collapses to the same L/Z/U the clear router emits, and
   `simplify` strips the now-collinear detour vertices. The last avoid frame ≈
   the first clear frame. This convergence is *why* the turn penalty must equal
   `margin` (§7.3) and the radius/stub must match. No cross-fade or hysteresis.
4. **No diagonals.** Every leg in both routers is axis-aligned (snake). Diagonal
   corner-anchor stubs are dropped permanently (`isCornerAnchor` retained only
   for back-compat detection; leave directions are always one of four side
   units).
5. **Curve mode parallelism.** For `style:"curve"`, `routeAround` renders the
   same simplified waypoints through `curvedPath` (Catmull-Rom, tension 1/6).
   Because waypoints sit on inflated clearance lines, the spline's bulge stays
   within `margin`. A *clear* `curve`/`bezier` edge uses the consumer's Bézier;
   an *avoid* `curve` edge uses `curvedPath`. Snake (the default) is exact-parity
   and is the primary target.

---

## 7. Obstacle router (`routeAround`) internals

### 7.1 Region clipping

```
pad    = margin*2 + 40
region = bbox(source, target) expanded by pad on all sides
obstacles := input.obstacles
   .filter(width>0 && height>0 && overlapsRegion)   // drop degenerate & far rects
   .map(r => inflate(r, margin))                      // uniform symmetric inflation
if obstacles.length == 0: return null                 // R1
```

### 7.2 Interval grid (sparse)

Lines are placed only where a turn could matter:

```
xs = uniqSorted([ source.x, s0.x, target.x, t0.x,
                  region.x + ring, region.x + region.w - ring,
                  ...obstacles.flatMap(r => [r.x, r.x + r.width]),
                  ...selfRectEdges_x ])     # §7.3
ys = same with .y / height / s0.y / t0.y / selfRectEdges_y
ring = margin + 24
```

- Terminals + stub tips guarantee start/goal cells exist and allow straight stub
  runs.
- Obstacle edges are the candidate "slide past this side" tracks (a Manhattan
  route only turns at inflated box edges).
- The ring gives two outer escape tracks so a route can wrap the far side when
  both near sides are blocked. Without it a box spanning the corridor would force
  `null` → a clear fallback that cuts the box.
- Coordinates are rounded so near-duplicate lines collapse (no zero-width cells).

Start/goal are the cells at the **stub tips** `s0`/`t0`, looked up by rounded
coordinate. A miss → `null` (R3).

### 7.3 Self-rect grid lines (parity, not obstacles)

When `sourceRect`/`targetRect` are passed, add their inflated edges to `xs`/`ys`
as candidate tracks, so an avoid-route that degenerates to a U wraps on the same
lines `orthRoute` uses (exact convergence, §6.3). **They are NOT added to the
`obstacles` array** used by `aaSegHitsRect` — A\* must be free to start and end
inside its own box's clearance zone. This is the one deliberate asymmetry: self
rects contribute grid lines but not blocking constraints.

### 7.4 A\* movement, blocking, turn penalty

```
state    = (cell, incoming-direction), bucketed as cell*4 + dir
step      = |Δx| + |Δy|
TURN      = margin                     # one bend ≈ one clearance unit
g(next)   = g(cur) + step + (incoming != none && incoming != outgoing ? TURN : 0)
h         = |x - goalx| + |y - goaly|  # admissible Manhattan
move rejected iff its axis-aligned segment enters any inflated obstacle interior (aaSegHitsRect)
cap       = xs.length * ys.length * 8 + 200    # overflow → null (R2)
```

Carrying the incoming direction in the state is what makes the turn penalty work
(the same cell reached east vs. south are different states). `TURN = margin` is
the parity lever: it must be ≥ typical grid spacing so the solver prefers one
long leg + one bend over a staircase, yielding the L/Z/U family. Keep it equal to
`margin`.

### 7.5 Reconstruction

Walk `came` back from the goal's best direction bucket, `unshift` each cell,
bracket with the **real** endpoints: `full = [source, ...gridPts, target]`. Run
the unified `simplify` (§3.2), then `roundedPath(simplified, radius)` /
`curvedPath`. Source/target are appended raw (not stub tips) so the path starts
and ends exactly at the handle, with the stub implied by the first/last grid leg.

---

## 8. Effective stub (weak spots #3) & radius & label

### 8.1 Effective-stub clamping

When `stub` exceeds the inter-node gap, `s1`/`t1` overshoot past the opposite
node and the naive Z/L backtracks or self-crosses. Clamp the effective stub per
endpoint:

```
gap     = facing-axis distance between the two node faces
          (or |T − S| projected on the leave axis when rects absent)
effStub = clamp(stub, MIN_STUB, max(MIN_STUB, gap*0.5 - radius))
MIN_STUB = max(radius, 4)
```

Recompute `s1`/`t1` with `effStub`. The two ends may end up with different
effective stubs (one node close, one far) — allowed and correct. The
`[S,s1]`/`[t1,T]` invariant is preserved; only the stub *length* shrinks. The
clamp guarantees the stub never crosses the facing midline, so the Z stays
monotonic and never self-crosses.

> **Overshoot demotion.** If, after stubbing, a facing pair's gap sign flips
> relative to the leave dir (`gapOK = (t1.x−s1.x)*sign(ds.x) > MIN_SEG` is
> false), demote the Z to a **U** on the perpendicular axis (§5.4 outside-jog).
> This converts a self-crossing Z into a clean U; same radius, so no visible
> snap.

`routeAround` MUST use the same clamped `effStub` so the avoid approach matches
the clear approach when the obstacle clears (§6.2).

### 8.2 Radius

`roundedPath(pts, radius)`, default `10`, both routers. Each corner radius is
independently clamped to `min(radius, dist(prev,cur)/2, dist(cur,next)/2)`, so a
huge radius never overshoots and a short leg degrades gracefully. After §8.1
clamping the shortest segment is `≥ MIN_STUB ≥ radius` on stubs and `≥ clr` on
jogs, so corners are fully rounded except in intentionally tight degenerate
cases.

### 8.3 Label anchor

`labelAnchor(pts)` is the point at half the cumulative polyline length, computed
on the **simplified** polyline (so the anchor sits on a real segment). Total
length 0 → returns `pts[0]`. Always finite. For **I**: midpoint of `S→T`. For
**Z**: on the mid-jog (the visual middle). For **U/C**: on the back of the wrap
(stable as nodes move). The consumer's `data.labelOffset` is added on top
unchanged.

---

## 9. Degenerate cases (weak spots #3, #4) — normative

Apply guards before/within dispatch; none may NaN, throw, self-cross, or
backtrack.

### 9.1 Coincident / near-coincident endpoints

`dist(S, T) < EPS_COINCIDENT` (or `< 1` for the visual-stub case): still push
stubs, build the case path, then `simplify` collapses near-duplicates to a tiny
but valid loop/stub from `S` to `T`. If only one unique point remains (stub 0 and
S == T), emit `"M S.x,S.y"` (a dot). Never `""`, never NaN. `labelAnchor` of a
zero-length polyline returns `pts[0]`.

### 9.2 Overlapping / very close nodes; stub > gap

Handled by §8.1 effective-stub clamping plus overshoot demotion (§8.1 note). For
`routeAround`, overlap is handled by inflation + A\*; if inflated boxes overlap so
heavily that A\* returns `null` (R2), the caller falls back to the now
overlap-safe `orthRoute`. If a chosen jog line would fall inside both boxes
simultaneously, push to the union-bbox outer edge + `clr`.

### 9.3 Zero-size / tiny nodes

`perimeterPoint` (consumer) already guards (`dy=1` when center-to-center is
`(0,0)`; half-extents clamped to `≥1`). The router contract: obstacle rects with
`width<=0 || height<=0` are filtered before A\*; a zero-area `sourceRect`/
`targetRect` for self-clearance is treated as a point (`rectRight = rect.x`), so
the §5 `max/min` terms degenerate harmlessly. No division by box dimensions
anywhere in `orthRoute`.

### 9.4 Float noise & non-finite input

`aligned`/`facing` decisions use `ALIGN_EPS` / `EPS_FACING`. All coordinates pass
`num()` (§3.3). `roundedPath` / `lerp` guard `len || 1`. A unit test greps the
output for `/NaN|Infinity|undefined/` and asserts no match.

### 9.5 Floating perimeter anchors

The router derives leave direction only from the supplied `Position` (the
consumer guarantees the perimeter point lies on that side), never re-deriving it
internally — so it needs no rect to know which way to leave. Because floating
endpoints move continuously, the router is continuous in its inputs: a 1px node
move never flips topology except at the exact facing/non-facing boundary, where
the `EPS_FACING` sign test resolves ties deterministically to the always-valid U
branch.

### 9.6 Manual waypoints

`pathThroughPoints` does not add stubs (manual mode = user owns geometry).
Consecutive duplicates and on-line (collinear) waypoints are removed by the
unified `simplify` so `roundedPath` never sees a zero-length neighbor.

---

## 10. `roundedPath` / `curvedPath` / `labelAnchor` numeric contract

- `roundedPath(pts, r)`: `< 2` pts → `""`; `== 2` pts → `"M a L b"`. Each corner
  trimmed by `min(r, dist/2)` per side; `lerp` divides by `len || 1`. After
  simplify, zero-length neighbors don't occur, but the guard is required for the
  "never NaN" contract.
- `curvedPath`: Catmull-Rom, used only for `curve`. Control arms (`/6` of the
  neighbor delta) may bulge off-axis — intended; axis-alignment is asserted only
  for `snake`.
- Output never contains `NaN`/`Infinity`/`undefined` (guaranteed by §3.3, §8.2,
  and the `|| 1` guards).
- `labelAnchor`: arc-length midpoint; total 0 → `pts[0]`; always finite;
  computed on the polyline, not the rounded `Q` path.

---

## 11. Test Matrix

Each row: **name** · **input** (S, T, sides; optional rects/obstacles; non-default
stub/radius) · **asserted property** of the output `pathD`. Properties are
checked on the **pre-jump** `pathD`, parsed into segments (a `Q` contributes its
endpoint; the rounded corner's two trimmed sub-segments are used for
axis-alignment). Defaults `stub = 32`, `radius = 10` unless noted.

Shared assertions:
- `STARTS_AT(S)` / `ENDS_AT(T)`: first `M` ≈ S, last point ≈ T within `EPS_COLLINEAR`.
- `AXIS_ALIGNED`: every snake polyline segment is H or V within `EPS_COLLINEAR`.
- `NO_NAN`: `pathD` matches none of `/NaN|Infinity|undefined/`.
- `BENDS == k`: direction changes after `simplify` equals `k`.
- `MONOTONE_X` / `MONOTONE_Y`: x (resp. y) sequence is non-decreasing or non-increasing.
- `OUTSIDE(rect)`: no polyline vertex in the strict interior of `rect`.
- `LEAVES(side)`: first segment from S points along `dir(side)` for ≥ `min(stub, MIN_SEG)`.
- `SINGLE_SUBPATH`: exactly one `M`; no `Z`; no `A`.

### 11.1 `orthRoute` — straight / aligned (I)

| Name | Input | Assert |
|---|---|---|
| `straight-horizontal` | S(0,0) R → T(200,0) L | `BENDS==0`, `AXIS_ALIGNED`, `MONOTONE_X`, `STARTS_AT`, `ENDS_AT`, `NO_NAN` |
| `straight-vertical` | S(0,0) B → T(0,200) T | `BENDS==0`, `AXIS_ALIGNED`, `MONOTONE_Y` |
| `straight-offset-tiny` | S(0,0) R → T(200,0.3) L | offset < `ALIGN_EPS` ⇒ `BENDS==0` (treated straight) |
| `I-aligned-facing` | S(100,30) R → T(400,30) L | `BENDS==0` (the case today mis-draws as U), `STARTS_AT`, `ENDS_AT` |

### 11.2 `orthRoute` — single corner (L)

| Name | Input | Assert |
|---|---|---|
| `L-right-to-top` | S(0,0) R → T(200,-200) B | `BENDS==1`, `AXIS_ALIGNED`, corner at `(t1.x, s1.y)` |
| `L-bottom-to-left` | S(0,0) B → T(200,200) L | `BENDS==1`, `AXIS_ALIGNED`, `LEAVES(bottom)` |
| `L-degenerate-corner` | S(0,0) R → T(0.2,200) B | corner collapses; `AXIS_ALIGNED`, `NO_NAN`, `ENDS_AT` |
| `MIXED-U-behind` | S(0,0) R → T(-40,200) B (corner would reverse source stub) | no segment with `dot(seg, ds) < -MIN_SEG`; `AXIS_ALIGNED`; `NO_NAN` |

### 11.3 `orthRoute` — facing → Z

| Name | Input | Assert |
|---|---|---|
| `Z-facing-x` | S(0,0) R → T(200,80) L | `BENDS==2`, `AXIS_ALIGNED`, jog x ≈ `(s1.x+t1.x)/2`, `STARTS_AT`/`ENDS_AT` |
| `Z-facing-y` | S(0,0) B → T(80,200) T | `BENDS==2`, jog y ≈ midpoint |
| `Z-facing-aligned` | S(0,0) R → T(200,0) L | jog collapses (`Δy=0`) ⇒ `BENDS==0` straight, no zero-length `Q` |
| `Z-jog-in-channel` | S(100,30) R → T(400,90) L | jog x between `s1.x` and `t1.x` (in the open channel, not on a node face) |

### 11.4 `orthRoute` — U / C / behind (weak spots #1, #2)

| Name | Input | Assert |
|---|---|---|
| `C-both-right` | S(0,0) R → T(0,120) R | `BENDS==2` clean C, `AXIS_ALIGNED`, back of C at `x ≥ max(s1.x,t1.x)` |
| `C-both-top` | S(0,0) T → T(120,0) T | back of C at `y ≤ min(s1.y,t1.y)`, `BENDS==2` |
| `U-target-behind-no-rect` | S(0,0) R → T(-200,5) L | path does NOT re-enter `x∈[S.x..s1.x]`; `AXIS_ALIGNED`; `NO_NAN` |
| `U-clears-source-rect` | S(0,0) R → T(0,40) R; `Rs={-60,-30,60,90}` | `OUTSIDE(Rs)` for every vertex; jog x ≥ `Rs.right + clr` |
| `U-clears-target-rect` | symmetric with `Rt` | `OUTSIDE(Rt)` |
| `U-turn-aligned-behind` | S(100,30) R; `Rs={0,0,100,60}` → T(40,30) L; `Rt={-60,0,80,60}` | `BENDS==4` hairpin, `OUTSIDE(Rs)` and `OUTSIDE(Rt)`, `NO_NAN` |
| `C-same-side-aligned` | S(0,0) R → T(0,0.2) R | flat-U with `max(clr,stub)` separation, no zero-length leg, `NO_NAN` |

### 11.5 `orthRoute` — coincident / tiny / extreme params (weak spot #4)

| Name | Input | Assert |
|---|---|---|
| `coincident-S-eq-T` | S(50,50) R → T(50,50) L, stub 14 | `NO_NAN`, `STARTS_AT`, `ENDS_AT`, finite label, ≥ 1 point |
| `coincident-stub0` | S(50,50) R → T(50,50) L, stub 0 | `"M 50,50"`, `NO_NAN`, no `Q` |
| `near-coincident` | S(0,0) R → T(1e-7,0) L | collapses to dot or 1px stub, `NO_NAN` |
| `negative-stub` | S(0,0) R → T(200,0) L, stub −20 | clamped to 0; behaves like `straight-horizontal`; `NO_NAN` |
| `nan-coord` | S(NaN,0) R → T(200,0) L | coord→0; `NO_NAN`; `STARTS_AT((0,0))` |
| `huge-radius` | any L case, radius 99999 | radius clamped to half shorter leg; no `Q` overshoot |
| `stub-gt-gap` | S(0,0) R → T(40,0) L, stub 32 | effStub clamped; `AXIS_ALIGNED`; no backtrack (`MONOTONE_X` on the join) |

### 11.6 `routeAround` — null semantics & clearance

| Name | Input | Assert |
|---|---|---|
| `around-no-obstacles` | S,T clear, `obstacles=[]` | returns `null` (R1) |
| `around-obstacle-far` | obstacle far from S→T region | returns `null` (R1, region filter) |
| `around-single-box` | S(0,0) R → T(300,0) L, obstacle `{120,-40,60,80}` on the line | non-null; `AXIS_ALIGNED`; every vertex `OUTSIDE(inflate(obstacle,margin))`; `STARTS_AT`/`ENDS_AT` |
| `around-zero-size-obstacle` | obstacle width 0 | filtered; if it was the only one → `null`, else routes around the rest |
| `around-no-route` | S,T boxed in, no orthogonal gap | returns `null` (R2); no throw/hang (cap respected) |
| `around-grid-miss` | construct so `s0` rounds off-grid | returns `null` (R3); no `xs[undefined]` |
| `style-parity-radius` | same S,T,sides with vs without a just-cleared obstacle | both use radius 10; identical first/last stub segments |
| `self-rect-grid-not-obstacle` | U-shaped avoid with `Rs`/`Rt` passed | route may start/end inside `Rs`/`Rt` clearance; wraps on self-rect lines; `OUTSIDE` for *other* obstacles only |

### 11.7 `pathThroughPoints` — manual waypoints

| Name | Input | Assert |
|---|---|---|
| `wp-empty` | `[]` | returns `["",0,0]` |
| `wp-single` | `[{5,5}]` | `"M 5,5"`, label `(5,5)`, `NO_NAN` |
| `wp-collinear-drop` | `[(0,0),(50,0),(100,0)]` | middle dropped, `BENDS==0` |
| `wp-collinear-float` | `[(0,0),(50,0.3),(100,0)]` (off by < 0.5) | middle dropped via tolerant simplify (regression vs old exact `===`), `BENDS==0` |
| `wp-dup-drop` | `[(0,0),(0,0.2),(40,40)]` | duplicate dropped, `NO_NAN`, no zero-length `Q` |
| `wp-snake-axis` | `[(0,0),(0,50),(50,50)]`, snake | `AXIS_ALIGNED`, `BENDS==1` |
| `wp-curve-smooth` | same pts, curve | `C` commands only; endpoints exact; `NO_NAN` (axis-alignment NOT asserted) |

### 11.8 Continuity / parity (cross-cutting)

| Name | Input | Assert |
|---|---|---|
| `single-subpath` | every producer, any non-empty input | `SINGLE_SUBPATH` (protects the comet) |
| `floating-continuity` | sweep T around S's perimeter in 1px steps across the facing boundary | `BENDS` changes by ≤ 1 at ≤ one step; never NaN; no frame passes through S's box (with rects) |
| `obstacle-in-out-parity` | animate a node into then out of the S→T line | leaving ⇒ `routeAround`→`null`→`orthRoute`; consecutive frames share stub/radius (no shape pop) |

---

## 12. Constants (single source of truth)

| Constant | Value | Owner | Notes |
|---|---|---|---|
| `OBSTACLE_MARGIN` / `margin` | 26 | consumer + router | the one clearance knob; drives `ring` & `TURN` |
| `stub` (clear default) | 14 | router | |
| `APPROACH_BUFFER` | `ARROW_WIDTH*2 = 32` | consumer | the stub the consumer actually passes |
| `radius` | 10 | both routers | MUST match across routers |
| `ring` | `margin + 24` | routeAround | outer wrap tracks |
| `TURN` | `= margin` | routeAround A\* | parity lever — keep equal to margin |
| `pad` (region) | `margin*2 + 40` | routeAround | local clip |
| `EPS_COLLINEAR` / `ALIGN_EPS` | 0.5 | simplify + dispatch | unified |
| `EPS_COINCIDENT` | 1e-6 | guards | |
| `EPS_FACING` | 1e-9 | facing sign test | |
| `MIN_STUB` | `max(radius, 4)` | effStub clamp | |
| `MIN_SEG` | 0.5 | shortest emitted segment | |

---

## 13. Guardrails (must NOT change)

- Public signatures of `orthRoute`, `routeAround`, `pathThroughPoints` and the
  exported `Pt` / `Rect` types stay stable. New `sourceRect` / `targetRect`
  (both routers) and `radius` (`routeAround`) are **optional trailing params**.
- Output is one continuous subpath (one `M`, no `Z`, no `A`). The comet and
  line-jump code in `AnimatedEdge` (≈ lines 200+) are untouched.
- Only the `routed` `useMemo` of `AnimatedEdge` (≈ lines 173–185) may be edited,
  and only to pass the optional rects (from the existing `ends` store / node
  lookup).
- `routeAround` and `orthRoute` MUST emit the same radius (10) and the same
  clamped stub, so an edge never visibly snaps shape as a node moves in or out of
  the way.
