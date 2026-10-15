// Board geometry for agents: node sizes, free-space placement and position clusters. Pure (no DB or
// React), so the API, the outline and the tests all share it. Sizes mirror the editor's defaults.

export type Rect = { x: number; y: number; w: number; h: number };
export type Dir = "right" | "left" | "above" | "below";
type Placed = { type: string; x: number; y: number; width: number | null; height: number | null; data?: Record<string, unknown> };

const DEFAULT_SIZE: Record<string, [number, number]> = {
  text: [180, 70], swatch: [120, 120], image: [220, 160], link: [240, 90], tracker: [200, 100],
};

export function sizeOf(type: string, width?: number | null, height?: number | null, data?: Record<string, unknown>) {
  if (width != null && height != null) return { w: width, h: height };
  if (type === "spreadsheet") {
    const rows = Number(data?.rows ?? 4), cols = Number(data?.cols ?? 4);
    return { w: 30 + 60 * cols, h: 22 * (rows + 1) };
  }
  const [w, h] = DEFAULT_SIZE[type] ?? [180, 70];
  return { w, h };
}

export const rectOf = (n: Placed): Rect => ({ x: n.x, y: n.y, ...sizeOf(n.type, n.width, n.height, n.data) });

export function union(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

const GAP = 40; // space left between a new node and its anchor
const PAD = 20; // minimum clearance from every other node
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w + PAD && b.x < a.x + a.w + PAD && a.y < b.y + b.h + PAD && b.y < a.y + a.h + PAD;

// Free spot for a w×h node beside `anchor` in direction `dir`: tries the slot right next to it, then slides
// along that side (alternating each way), then steps one row/column further out. No anchor = below the
// whole board (or the origin on an empty board).
export function findSpot(occupied: Rect[], anchor: Rect | null, dir: Dir, w: number, h: number): { x: number; y: number } {
  if (!anchor) {
    const all = union(occupied);
    if (!all) return { x: 0, y: 0 };
    anchor = all;
    dir = "below";
  }
  const horiz = dir === "right" || dir === "left";
  for (let ring = 0; ring < 25; ring++) {
    const base =
      dir === "right" ? anchor.x + anchor.w + GAP + ring * (w + GAP)
      : dir === "left" ? anchor.x - GAP - w - ring * (w + GAP)
      : dir === "below" ? anchor.y + anchor.h + GAP + ring * (h + GAP)
      : anchor.y - GAP - h - ring * (h + GAP);
    for (let k = 0; k < 15; k++) {
      const slide = (k % 2 ? -1 : 1) * Math.ceil(k / 2) * ((horiz ? h : w) + GAP);
      const r = horiz ? { x: base, y: anchor.y + slide, w, h } : { x: anchor.x + slide, y: base, w, h };
      if (!occupied.some((o) => overlaps(r, o))) return { x: Math.round(r.x), y: Math.round(r.y) };
    }
  }
  return { x: Math.round(anchor.x), y: Math.round(anchor.y + anchor.h + GAP) }; // crowded board: stack below
}

// Items whose rects sit within `gap` px of each other (transitively) form one cluster.
export function clusters<T>(items: T[], rect: (t: T) => Rect, gap = 120): T[][] {
  const rs = items.map(rect), parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    if (a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap) parent[find(i)] = find(j);
  }
  const groups = new Map<number, T[]>();
  items.forEach((t, i) => { const k = find(i); groups.set(k, [...(groups.get(k) ?? []), t]); });
  return [...groups.values()];
}
