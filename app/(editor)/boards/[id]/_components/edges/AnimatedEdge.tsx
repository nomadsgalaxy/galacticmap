"use client";

import { type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  useStore,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
  type ReactFlowState,
} from "@xyflow/react";
import { blockingRects, cornerDir, orthRoute, pathThroughPoints, routeAround, type Pt, type Rect } from "./orthogonalRoute";
import { applyJumps, crossingsOf, samplePath } from "./lineJumps";
import { useCanvasStore } from "../../_store/canvasStore";
import { useEdgePaths } from "../../_store/edgePaths";
import { updateEdgeStyle } from "../../actions";

// The "dynamic line": a fully customizable connector. All design lives in edge.data:
//   color, width, lineStyle (flow|solid|dashed|dotted), routing (avoid|bezier|smoothstep|step|straight),
//   avoidStyle (snake|curve — how an "avoid" detour is drawn), flowSpeed, flowDir.
//
// routing "avoid" (default): keeps a soft bezier when the path is clear, and bends around any node
// in the way (orthogonal "snake" or smooth "curve"). Corner anchors leave at 45°. See orthogonalRoute.
// lineStyle "flow": a directional comet — a bright glowing pulse with a fading tail that travels
// source→target (reversible) along the line.
// anchor "auto": both ends float — they slide around their node's perimeter, always aimed at the
// other end (recomputed as nodes move). "fixed" (default): pinned to the chosen handle anchors.
type EdgeData = {
  color?: string;
  width?: number;
  lineStyle?: "flow" | "solid" | "dashed" | "dotted";
  routing?: "avoid" | "bezier" | "smoothstep" | "step" | "straight";
  avoidStyle?: "snake" | "curve";
  anchor?: "auto" | "fixed";
  waypoints?: Pt[]; // manual bend points (flow coords); when present the path follows them, no auto-route
  stub?: number; // approach run into/out of a node before the route turns (avoid routing)
  labelOffset?: { dx: number; dy: number }; // drag a label off its natural midpoint (flow coords)
  flowSpeed?: number;
};

const OBSTACLE_MARGIN = 26; // buffer kept between a trail and node borders (so lines don't ride edges)
const ARROW_WIDTH = 16; // markerEnd/markerStart width (see toRFEdge / EdgeInspector)
const APPROACH_BUFFER = ARROW_WIDTH * 2; // straight run into/out of a node before the route turns
const EMPTY: Rect[] = [];

function sameRects(a: Rect[], b: Rect[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.x !== y.x || x.y !== y.y || x.width !== y.width || x.height !== y.height) return false;
  }
  return true;
}

type Ends = { src: Rect | null; tgt: Rect | null };
const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
const sameEnds = (a: Ends | null, b: Ends | null) =>
  a === b || (!!a && !!b && sameRect(a.src, b.src) && sameRect(a.tgt, b.tgt));

// Per-endpoint rotation state: the node's CENTER (flow coords) and its rotation in DEGREES
// (clockwise-positive, stored at node.data.rotation; absent ⇒ 0). The connector endpoint sits on the
// ROTATED node perimeter and the lead leaves perpendicular to the rotated edge, so we need both.
type Spin = { x: number; y: number; rot: number; w: number; h: number };
type Spins = { src: Spin | null; tgt: Spin | null };
const sameSpin = (a: Spin | null, b: Spin | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.rot === b.rot && a.w === b.w && a.h === b.h);
const sameSpins = (a: Spins | null, b: Spins | null) =>
  a === b || (!!a && !!b && sameSpin(a.src, b.src) && sameSpin(a.tgt, b.tgt));

// CSS `rotate(${deg}deg)` is clockwise for positive deg in screen coords (y-down). The matching matrix
// in those coords is R(deg): x' = x·cos − y·sin, y' = x·sin + y·cos. (Sanity: deg=90 sends the right
// offset (1,0) to (0,1) — the bottom — exactly where CSS puts a node's right edge after a 90° spin.)
function rotateVec(v: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
const rotateAround = (p: Pt, center: Pt, deg: number): Pt => {
  const r = rotateVec({ x: p.x - center.x, y: p.y - center.y }, deg);
  return { x: center.x + r.x, y: center.y + r.y };
};
// Position → unit outward normal of that (un-rotated) side.
const SIDE_VEC: Record<string, Pt> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
const sideVec = (p: Position): Pt => SIDE_VEC[p as string] ?? SIDE_VEC.right;
// Each fixed anchor's offset from the node CENTER as a fraction of (w, h) — matches NodeHandles' 8 anchors
// (4 side-midpoints + 4 corners).
const ANCHOR_OFF: Record<string, Pt> = {
  t: { x: 0, y: -0.5 }, b: { x: 0, y: 0.5 }, l: { x: -0.5, y: 0 }, r: { x: 0.5, y: 0 },
  tl: { x: -0.5, y: -0.5 }, tr: { x: 0.5, y: -0.5 }, bl: { x: -0.5, y: 0.5 }, br: { x: 0.5, y: 0.5 },
};
// Exact flow-coord position of a fixed anchor on a (possibly rotated) node — computed straight from the
// node's geometry + angle, NOT from React Flow's measured handle bounds. Those bounds are captured at
// mount/resize and are NOT re-measured on a CSS rotate, so they're stale/distorted for a rotated node;
// deriving the point ourselves makes the anchor exact at any angle. null ⇒ unknown id (caller falls back).
function anchorPoint(spin: Spin, anchorId: string | undefined): Pt | null {
  const off = anchorId ? ANCHOR_OFF[anchorId] : undefined;
  if (!off) return null;
  const v = rotateVec({ x: off.x * spin.w, y: off.y * spin.h }, spin.rot);
  return { x: spin.x + v.x, y: spin.y + v.y };
}
// Outward normal → which Position that side is (inverse of sideVec; used by the floating-anchor path
// after we resolve the perimeter exit in the node-LOCAL un-rotated frame).
const sideOfVec = (v: Pt): Position =>
  Math.abs(v.x) >= Math.abs(v.y) ? (v.x >= 0 ? Position.Right : Position.Left) : (v.y >= 0 ? Position.Bottom : Position.Top);

// Floating endpoint: where the ray from `rect` center toward `toward` exits the rectangle, plus the
// side it exits on (drives the route's leave direction). This is the draw.io "floating connection"
// (RectanglePerimeter) — the endpoint slides around the node as it moves.
function perimeterPoint(rect: Rect, toward: { x: number; y: number }): { x: number; y: number; pos: Position } {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  let dx = toward.x - cx, dy = toward.y - cy;
  if (dx === 0 && dy === 0) dy = 1;
  const w = Math.max(1, rect.width / 2), h = Math.max(1, rect.height / 2);
  const scale = 1 / Math.max(Math.abs(dx) / w, Math.abs(dy) / h);
  const horizontal = Math.abs(dx) / w >= Math.abs(dy) / h;
  return {
    x: cx + dx * scale,
    y: cy + dy * scale,
    pos: horizontal ? (dx >= 0 ? Position.Right : Position.Left) : (dy >= 0 ? Position.Bottom : Position.Top),
  };
}
const centerOf = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

export function AnimatedEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  targetHandleId,
  label,
  selected,
  markerEnd,
  markerStart,
  data,
}: EdgeProps) {
  const d = (data ?? {}) as EdgeData;
  const routing = d.routing ?? "avoid";
  const avoidStyle = d.avoidStyle ?? "snake";
  const floating = (d.anchor ?? "fixed") === "auto";
  const canEdit = useCanvasStore((s) => s.canEdit);
  const waypoints = d.waypoints ?? [];
  const stub = d.stub ?? APPROACH_BUFFER;
  const labelOffset = d.labelOffset ?? { dx: 0, dy: 0 };

  // Other nodes are obstacles. Only subscribe (and pay the re-render cost) for "avoid" edges;
  // clouds are decorative backgrounds and the two endpoints are never their own obstacle.
  const obstacles = useStore(
    useCallback(
      (s: ReactFlowState) => {
        if (routing !== "avoid") return EMPTY;
        const rects: Rect[] = [];
        for (const n of s.nodeLookup.values()) {
          if (n.id === source || n.id === target || n.type === "cloud") continue;
          const w = n.measured?.width ?? (typeof n.width === "number" ? n.width : 0);
          const h = n.measured?.height ?? (typeof n.height === "number" ? n.height : 0);
          if (!w || !h) continue;
          const p = n.internals.positionAbsolute;
          rects.push({ x: p.x, y: p.y, width: w, height: h });
        }
        return rects;
      },
      [routing, source, target]
    ),
    sameRects
  );

  // Live rects of THIS edge's two endpoint nodes — only needed for floating anchors.
  const ends = useStore(
    useCallback(
      (s: ReactFlowState): Ends | null => {
        if (!floating) return null;
        const rect = (nid?: string): Rect | null => {
          const n = nid ? s.nodeLookup.get(nid) : undefined;
          if (!n) return null;
          const w = n.measured?.width ?? (typeof n.width === "number" ? n.width : 0);
          const h = n.measured?.height ?? (typeof n.height === "number" ? n.height : 0);
          if (!w || !h) return null;
          const p = n.internals.positionAbsolute;
          return { x: p.x, y: p.y, width: w, height: h };
        };
        return { src: rect(source), tgt: rect(target) };
      },
      [floating, source, target]
    ),
    sameEnds
  );

  // Rotation state of THIS edge's two endpoint nodes (center + rotation degrees). Needed by EVERY
  // routing + manual waypoints so anchor points follow a tilted node. Center = positionAbsolute +
  // measured/2 (fallback w/h).
  const spins = useStore(
    useCallback(
      (s: ReactFlowState): Spins | null => {
        const spin = (nid?: string): Spin | null => {
          const n = nid ? s.nodeLookup.get(nid) : undefined;
          if (!n) return null;
          const w = n.measured?.width ?? (typeof n.width === "number" ? n.width : 0);
          const h = n.measured?.height ?? (typeof n.height === "number" ? n.height : 0);
          const p = n.internals.positionAbsolute;
          const rot = Number((n.data as { rotation?: unknown } | undefined)?.rotation ?? 0) || 0;
          return { x: p.x + w / 2, y: p.y + h / 2, rot, w, h };
        };
        return { src: spin(source), tgt: spin(target) };
      },
      [routing, source, target]
    ),
    sameSpins
  );

  // Effective endpoints: the fixed handle coords React Flow gives us, OR — when floating — the
  // perimeter points where the line between the two node centers exits each node.
  const ep = useMemo(() => {
    let sx = sourceX, sy = sourceY, sPos = sourcePosition ?? Position.Right, sAnchor = sourceHandleId ?? undefined;
    let tx = targetX, ty = targetY, tPos = targetPosition ?? Position.Left, tAnchor = targetHandleId ?? undefined;
    if (floating && ends?.src && ends?.tgt) {
      const sp = perimeterPoint(ends.src, centerOf(ends.tgt));
      const tp = perimeterPoint(ends.tgt, centerOf(ends.src));
      sx = sp.x; sy = sp.y; sPos = sp.pos; sAnchor = undefined;
      tx = tp.x; ty = tp.y; tPos = tp.pos; tAnchor = undefined;
    }
    return { sx, sy, sPos, sAnchor, tx, ty, tPos, tAnchor };
  }, [floating, ends, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, sourceHandleId, targetHandleId]);

  // Endpoints rotated to follow a tilted node: CSS rotates the node + its handles, but React Flow's
  // handle coords stay axis-aligned. "avoid" routing rotates inside `resolve`; the straight/curve paths
  // AND manual-waypoint paths below use these rotated points so their anchors track rotation too.
  const rotEnd = (p: Pt, spin: Spin | null, anchorId: string | undefined): Pt =>
    !spin || !spin.rot ? p : (anchorPoint(spin, anchorId) ?? rotateAround(p, { x: spin.x, y: spin.y }, spin.rot));
  const sPt = rotEnd({ x: ep.sx, y: ep.sy }, spins?.src ?? null, ep.sAnchor);
  const tPt = rotEnd({ x: ep.tx, y: ep.ty }, spins?.tgt ?? null, ep.tAnchor);
  const base = { sourceX: sPt.x, sourceY: sPt.y, targetX: tPt.x, targetY: tPt.y };
  const withPos = { ...base, sourcePosition: ep.sPos, targetPosition: ep.tPos };

  // Default "avoid" routing is ALWAYS orthogonal (draw.io style): clean right-angle L/Z/U when the path
  // is clear (orthRoute), and the same rounded orthogonal style routed around any node in the way
  // (routeAround). No more snapping between a soft bezier and right-angles.
  const routed = useMemo(() => {
    if (routing !== "avoid" || waypoints.length > 0) return null; // manual waypoints override auto-route
    // Source/target node boxes (floating edges expose them via `ends`); let the routers clear their
    // own node on a U-turn. Undefined for fixed edges → back-compat rectless behavior.
    const sourceRect = ends?.src ?? undefined, targetRect = ends?.tgt ?? undefined;
    const srcRot = spins?.src?.rot ?? 0, tgtRot = spins?.tgt?.rot ?? 0;

    // Resolve one endpoint to its on-perimeter point, leave direction, and Position. When the node is
    // rotated (rot !== 0) the endpoint must sit on the ROTATED perimeter and leave perpendicular to the
    // rotated edge: a short angled lead (unit diagonal) the router brackets on, then orthogonal as usual.
    //   • rot === 0: identical to today — handle point as-is; corner anchors keep their 45° cornerDir lead.
    //   • rot !== 0, fixed: rotate the handle point about the center; rotate the base leave (cornerDir for
    //     corner anchors, else the side's outward normal) by the same angle.
    //   • rot !== 0, floating ("auto"): the perimeter exit on a rotated rect = run the axis-aligned
    //     perimeterPoint in the node-LOCAL un-rotated frame (rotate the "toward" point by −rot), then
    //     rotate the exit back by +rot; lead = rotateVec(sideVec(localExitSide), rot).
    const resolve = (
      handle: Pt, pos: Position, anchorId: string | undefined,
      spin: Spin | null, rot: number, towardCenter: Pt | null, rect: Rect | undefined,
    ): { point: Pt; pos: Position; corner: Pt | undefined } => {
      if (rot === 0 || !spin) {
        return { point: handle, pos, corner: cornerDir(anchorId) };
      }
      const center = { x: spin.x, y: spin.y };
      if (floating && rect && towardCenter) {
        const localToward = rotateAround(towardCenter, center, -rot);
        const exit = perimeterPoint(rect, localToward);
        const point = rotateAround({ x: exit.x, y: exit.y }, center, rot);
        return { point, pos: exit.pos, corner: rotateVec(sideVec(exit.pos), rot) };
      }
      const baseLeave = cornerDir(anchorId) ?? sideVec(pos);
      // Prefer the geometry-derived anchor (exact under rotation); fall back to rotating the reported coord.
      const point = anchorPoint(spin, anchorId) ?? rotateAround(handle, center, rot);
      return { point, pos, corner: rotateVec(baseLeave, rot) };
    };

    const tgtCenter = spins?.tgt ? { x: spins.tgt.x, y: spins.tgt.y } : null;
    const srcCenter = spins?.src ? { x: spins.src.x, y: spins.src.y } : null;
    const S = resolve({ x: ep.sx, y: ep.sy }, ep.sPos, ep.sAnchor, spins?.src ?? null, srcRot, tgtCenter, sourceRect);
    const T = resolve({ x: ep.tx, y: ep.ty }, ep.tPos, ep.tAnchor, spins?.tgt ?? null, tgtRot, srcCenter, targetRect);

    const a = S.point, b = T.point;
    const sourceCorner = S.corner, targetCorner = T.corner;
    // Departure/approach FOLLOW rotation: snap each rotated leave vector to its nearest cardinal so the
    // orthogonal legs — and therefore the auto-oriented arrowhead — leave/enter along the node's ROTATED
    // side (a 90° spin turns a Right anchor's leave into Bottom). A non-cardinal tilt still gets the exact
    // 45°-style angled lead via sourceCorner below. rot===0 keeps the original Position exactly.
    const sPosEff = srcRot !== 0 ? sideOfVec(S.corner ?? sideVec(S.pos)) : S.pos;
    const tPosEff = tgtRot !== 0 ? sideOfVec(T.corner ?? sideVec(T.pos)) : T.pos;
    const blocked = obstacles.length > 0 && blockingRects(a, b, obstacles, OBSTACLE_MARGIN).length > 0;
    if (blocked) {
      // ponytail: obstacle detours stay perpendicular (no 45° angled lead — routeAround's RouteInput has
      // no corner-lead field), but still exit the rotated face via the snapped positions above.
      const around = routeAround({
        source: a, target: b, sourcePosition: sPosEff, targetPosition: tPosEff,
        obstacles, margin: OBSTACLE_MARGIN, stub, radius: 10, style: avoidStyle, sourceRect, targetRect,
      });
      if (around) return around;
    }
    return orthRoute({ source: a, target: b, sourcePosition: sPosEff, targetPosition: tPosEff, stub, radius: 10, sourceRect, targetRect, sourceCorner, targetCorner });
  }, [routing, avoidStyle, obstacles, ep, ends, spins, floating, waypoints.length, stub]);

  const [path, labelX, labelY] = waypoints.length
    ? pathThroughPoints([sPt, ...waypoints, tPt], avoidStyle)
    : routed
      ? routed
      : routing === "straight"
        ? getStraightPath(base)
        : routing === "step" || routing === "smoothstep"
          ? getSmoothStepPath({ ...withPos, borderRadius: routing === "step" ? 0 : 5 })
          : getBezierPath(withPos); // "bezier" and clear "avoid" trails both get a soft curve

  const editor = selected && canEdit
    ? <WaypointEditor edgeId={id} a={sPt} b={tPt} waypoints={waypoints} />
    : null;

  // Line jumps: publish our (base) polyline to the shared registry, and where we cross another trail
  // with a smaller id, hop over it (so exactly one of each crossing pair hops). Off by default.
  const jumpStyle = useCanvasStore((s) => s.jumpStyle);
  const publishPath = useEdgePaths((s) => s.publish);
  const dropPath = useEdgePaths((s) => s.drop);
  const polys = useEdgePaths((s) => s.polys);
  const selfPoly = useMemo(() => (jumpStyle === "none" ? null : samplePath(path)), [jumpStyle, path]);
  useEffect(() => {
    if (!selfPoly) {
      dropPath(id);
      return;
    }
    publishPath(id, selfPoly);
    return () => dropPath(id);
  }, [id, selfPoly, publishPath, dropPath]);
  const renderPath = useMemo(() => {
    if (jumpStyle === "none" || !selfPoly) return path;
    const others: Pt[][] = [];
    for (const oid in polys) if (oid !== id && oid < id) others.push(polys[oid]);
    if (!others.length) return path;
    const crossings = crossingsOf(selfPoly, others);
    return crossings.length ? applyJumps(selfPoly, crossings, jumpStyle, 14) : path;
  }, [jumpStyle, selfPoly, polys, id, path]);

  // Default connector color follows the global color scheme (Material-3 primary token). A per-edge
  // color set in the inspector still overrides. CSS vars only resolve in `style`, never in the SVG
  // `stroke`/`fill` attribute — so every stroke below is applied via style.
  const color = d.color ?? "var(--md-sys-color-primary)";
  const width = d.width ?? 2;
  const lineStyle = d.lineStyle ?? "flow";
  const flow = lineStyle === "flow";
  const speed = d.flowSpeed ?? 1;

  if (flow) {
    // Directional comet: a dim base line + a fading tail + a bright glowing head that travel along
    // the path source→target (pathLength normalized to 100 so one pulse spans any edge length).
    // To reverse direction, swap the connector's source/target (no separate flow-direction setting).
    const dur = `${(2 / Math.max(0.2, speed)).toFixed(2)}s`;
    const cometStyle: CSSProperties = { animationDuration: dur };
    return (
      <>
        {/* Static base line uses the JUMPED path (shows the line-jump gaps/arcs). The comet, however,
            animates along the CONTINUOUS pre-jump `path`: SVG restarts the dash pattern at each subpath,
            so a gap-broken path would spawn one comet per segment — animating the single continuous
            path keeps it to exactly ONE comet per connector. */}
        <BaseEdge id={id} path={renderPath} markerEnd={markerEnd} markerStart={markerStart} style={{ stroke: color, strokeWidth: width, opacity: 0.4 }} />
        <path d={path} fill="none" pathLength={100} strokeWidth={width} strokeLinecap="round" className="gb-comet-tail" style={{ ...cometStyle, stroke: color }} />
        <path d={path} fill="none" pathLength={100} strokeWidth={width + 0.5} strokeLinecap="round" className="gb-comet-head" style={{ ...cometStyle, color, stroke: color }} />
        {label ? <DraggableLabel edgeId={id} x={labelX} y={labelY} offset={labelOffset} canEdit={canEdit}>{label}</DraggableLabel> : null}
        {editor}
      </>
    );
  }

  const style: CSSProperties = { stroke: color, strokeWidth: width };
  if (lineStyle === "dashed") style.strokeDasharray = "8 6";
  else if (lineStyle === "dotted") style.strokeDasharray = "1.5 5";

  return (
    <>
      <BaseEdge id={id} path={renderPath} markerEnd={markerEnd} markerStart={markerStart} style={style} />
      {label ? <DraggableLabel edgeId={id} x={labelX} y={labelY} offset={labelOffset} canEdit={canEdit}>{label}</DraggableLabel> : null}
      {editor}
    </>
  );
}

// Manual bend points: solid handles per waypoint (drag to move, double-click to remove) + faint
// ghost handles at each segment midpoint (drag to add a new bend, draw.io's "virtual bends").
function WaypointEditor({ edgeId, a, b, waypoints }: { edgeId: string; a: Pt; b: Pt; waypoints: Pt[] }) {
  const boardId = useCanvasStore((s) => s.boardId);
  const updateEdge = useCanvasStore((s) => s.updateEdge);
  const zoom = useStore((s) => s.transform[2]);

  const apply = (next: Pt[], persist: boolean) => {
    updateEdge(edgeId, { data: { waypoints: next } });
    if (persist) void updateEdgeStyle(boardId, edgeId, { data: { waypoints: next } });
  };

  // Drag via window listeners so it survives the re-renders each move triggers (no mount dependency).
  const startDrag = (index: number, orig: Pt[], e: ReactPointerEvent) => {
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const at = (ev: PointerEvent) =>
      orig.map((w, i) => (i === index ? { x: orig[index].x + (ev.clientX - sx) / zoom, y: orig[index].y + (ev.clientY - sy) / zoom } : w));
    const move = (ev: PointerEvent) => apply(at(ev), false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      apply(at(ev), true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const chain = [a, ...waypoints, b];
  return (
    <EdgeLabelRenderer>
      {chain.slice(0, -1).map((p, k) => {
        const mid = { x: (p.x + chain[k + 1].x) / 2, y: (p.y + chain[k + 1].y) / 2 };
        return (
          <div
            key={`g${k}`}
            title="Drag to add a bend"
            onPointerDown={(e) => {
              const next = [...waypoints.slice(0, k), mid, ...waypoints.slice(k)];
              apply(next, false);
              startDrag(k, next, e);
            }}
            className="nodrag nopan pointer-events-auto absolute h-2.5 w-2.5 cursor-grab rounded-full border border-primary/60 bg-surface opacity-40 transition-opacity hover:opacity-100"
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
          />
        );
      })}
      {waypoints.map((w, i) => (
        <div
          key={`w${i}`}
          title="Drag to move · double-click to remove"
          onPointerDown={(e) => startDrag(i, waypoints, e)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            apply(waypoints.filter((_, j) => j !== i), true);
          }}
          className="nodrag nopan pointer-events-auto absolute h-3 w-3 cursor-grab rounded-full border-2 border-primary bg-surface shadow-elev-1"
          style={{ transform: `translate(-50%, -50%) translate(${w.x}px, ${w.y}px)` }}
        />
      ))}
    </EdgeLabelRenderer>
  );
}

// Edge label at the path midpoint, draggable (when editable) to nudge it off a busy crossing.
// Offset is stored in edge.data.labelOffset (flow coords); double-click recenters it.
function DraggableLabel({
  edgeId,
  x,
  y,
  offset,
  canEdit,
  children,
}: {
  edgeId: string;
  x: number;
  y: number;
  offset: { dx: number; dy: number };
  canEdit: boolean;
  children: ReactNode;
}) {
  const boardId = useCanvasStore((s) => s.boardId);
  const updateEdge = useCanvasStore((s) => s.updateEdge);
  const zoom = useStore((s) => s.transform[2]);
  const apply = (next: { dx: number; dy: number }, persist: boolean) => {
    updateEdge(edgeId, { data: { labelOffset: next } });
    if (persist) void updateEdgeStyle(boardId, edgeId, { data: { labelOffset: next } });
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!canEdit) return;
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const at = (ev: PointerEvent) => ({ dx: offset.dx + (ev.clientX - sx) / zoom, dy: offset.dy + (ev.clientY - sy) / zoom });
    const move = (ev: PointerEvent) => apply(at(ev), false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      apply(at(ev), true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <EdgeLabelRenderer>
      <div
        onPointerDown={onPointerDown}
        onDoubleClick={canEdit ? (e) => { e.stopPropagation(); apply({ dx: 0, dy: 0 }, true); } : undefined}
        title={canEdit ? "Drag to move · double-click to recenter" : undefined}
        style={{ transform: `translate(-50%, -50%) translate(${x + offset.dx}px, ${y + offset.dy}px)` }}
        className={`nodrag nopan absolute rounded border border-outline-variant bg-surface-container px-1 text-[10px] text-on-surface shadow-elev-1 ${canEdit ? "pointer-events-auto cursor-move" : "pointer-events-none"}`}
      >
        {children}
      </div>
    </EdgeLabelRenderer>
  );
}
