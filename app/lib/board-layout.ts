// Board geometry for agents: node sizes, free-space placement and position clusters. Pure (no DB or
// React), so the API, the outline and the tests all share it. Sizes mirror the editor's defaults.

export type Rect = { x: number; y: number; w: number; h: number };
export type Dir = "right" | "left" | "above" | "below";
type Placed = { type: string; x: number; y: number; width: number | null; height: number | null; data?: Record<string, unknown> };

const DEFAULT_SIZE: Record<string, [number, number]> = {
  text: [180, 70], swatch: [120, 120], image: [220, 160], link: [240, 90], tracker: [200, 100],
};

// An unsized text card is as wide as its longest line (160–280px) and as tall as its Markdown, so a long
// checklist is far bigger than the 180×70 default. Estimate that from the text, mirroring TextNode and
// .gb-md: text-sm (14px on 20px lines), px-3 py-2, GFM blocks (lines join into paragraphs; lists, headings
// and blank lines split them). Checked against the browser's measured sizes in the e2e tests.
const CHAR = 0.5; // average glyph width in em for the UI's sans font
export function textSize(data?: Record<string, unknown>): { w: number; h: number } {
  const fs = typeof data?.fontSize === "number" ? data.fontSize : 14, line = fs * (20 / 14);
  const src = typeof data?.text === "string" ? data.text : "";
  const blocks: { text: string; scale: number; indent: number; gap: number }[] = [];
  let para: string[] = [], blank = false, paraGap = 0.4;
  const flush = (gap = paraGap) => { if (para.length) blocks.push({ text: para.join(" "), scale: 1, indent: 0, gap }); para = []; paraGap = 0.4; };
  for (const raw of src.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]|<[^>]+>/g, "").split("\n")) {
    const l = raw.trim(), h = /^(#{1,6})\s+(.*)$/.exec(l), li = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l);
    const prev = blocks[blocks.length - 1];
    if (!l) { flush(); blank = true; continue; }
    if (h) { flush(); blocks.push({ text: h[2], scale: h[1].length === 1 ? 1.25 : h[1].length === 2 ? 1.12 : 1, indent: 0, gap: 0.3 }); }
    // A blank line between list items makes a "loose" list: each item gets paragraph spacing.
    else if (li) { flush(); blocks.push({ text: li[1], scale: 1, indent: /^\s{2,}/.test(raw) ? 2.4 : 1.2, gap: blank && prev?.indent ? 0.8 : 0.1 }); }
    else if (raw.startsWith("  ") && prev?.indent && !para.length) prev.text += " " + l;
    // A line ending in "\" (or two spaces) is a hard break: a new line in the same paragraph.
    else if (/(\\|  )$/.test(raw)) { para.push(l.replace(/\\$/, "")); flush(); paraGap = 0; }
    else para.push(l);
    blank = false;
  }
  flush();
  const room = 280 - 26; // max-w minus padding and border
  let widest = 0, h = 18; // py-2 + border
  blocks.forEach((b, i) => {
    const px = b.text.length * fs * b.scale * CHAR;
    widest = Math.max(widest, px + b.indent * fs);
    // Words wrap before the line is full, so a line holds a bit less than its width.
    const lines = Math.max(1, Math.ceil(px / ((room - b.indent * fs) * 0.92)));
    h += lines * line * b.scale + (i ? b.gap * fs : 0);
  });
  if (!blocks.length) h += line;
  h *= 1.03; // err on the big side: an overestimate leaves a gap, an underestimate overlaps
  const icons = (Array.isArray(data?.icons) && data.icons.length > 0) || !!data?.notes;
  return { w: Math.round(Math.min(280, Math.max(160, widest + 26))), h: Math.round(h + (icons ? 24 : 0)) };
}

export function sizeOf(type: string, width?: number | null, height?: number | null, data?: Record<string, unknown>) {
  if (width != null && height != null) return { w: width, h: height };
  if (type === "text") return textSize(data);
  if (type === "link") {
    // LinkNode: 260 wide; domain + title (55), an h-28 preview image, and up to two lines of 12px description.
    const desc = typeof data?.description === "string" ? data.description : "";
    return { w: 260, h: 55 + (data?.image ? 112 : 0) + (desc ? (desc.length * 6 > 240 ? 34 : 18) : 0) };
  }
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

// ── Tidy mind-map layout ──────────────────────────────────────────────────────────────────────────────
type TreeNode = Placed & { id: string; parentId: string | null; collapsed?: boolean };
const HGAP = 80, VGAP = 24; // between a parent and its children; between siblings

// New positions for every node under `rootId`, laid out as a tidy tree from their real sizes: each child
// column centred on its parent, siblings kept in their current top-to-bottom order. "balanced" splits the
// root's children between its right and left sides. The root stays where it is; collapsed branches keep
// their hidden children where they are.
export function tidyTree(
  nodes: TreeNode[], rootId: string, dir: "right" | "left" | "balanced", groupOf: Map<string, string> = new Map(),
): Map<string, { x: number; y: number }> {
  // Neighbouring branches in different groups need room for both clouds' padding and label between them.
  const gap = (a: TreeNode, b: TreeNode) => (groupOf.get(a.id) === groupOf.get(b.id) ? VGAP : VGAP + CLOUD_PAD * 2 + CLOUD_LABEL + 8);
  const gaps = (list: TreeNode[]) => list.slice(1).reduce((s, k, i) => s + gap(list[i], k), 0);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, TreeNode[]>();
  for (const n of nodes) if (n.parentId && byId.has(n.parentId)) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const list of kids.values()) list.sort((a, b) => a.y - b.y || a.x - b.x);
  const open = (n: TreeNode) => (n.collapsed ? [] : kids.get(n.id) ?? []);
  const spans = new Map<string, number>();
  const span = (n: TreeNode, seen = new Set<string>()): number => {
    if (spans.has(n.id)) return spans.get(n.id)!;
    if (seen.has(n.id)) return rectOf(n).h; // a parent cycle in bad data: stop
    seen.add(n.id);
    const ks = open(n), inner = ks.reduce((s, k) => s + span(k, seen), 0) + gaps(ks);
    const v = Math.max(rectOf(n).h, inner);
    spans.set(n.id, v);
    return v;
  };
  const out = new Map<string, { x: number; y: number }>();
  const column = (list: TreeNode[], edge: number, cy: number, side: 1 | -1) => {
    let y = cy - (list.reduce((s, k) => s + span(k), 0) + gaps(list)) / 2;
    for (const [j, k] of list.entries()) {
      if (j) y += gap(list[j - 1], k) - VGAP;
      const s = span(k), r = rectOf(k), x = side > 0 ? edge : edge - r.w;
      out.set(k.id, { x: Math.round(x), y: Math.round(y + s / 2 - r.h / 2) });
      column(open(k), side > 0 ? x + r.w + HGAP : x - HGAP, y + s / 2, side);
      y += s + VGAP;
    }
  };
  const root = byId.get(rootId);
  if (!root) return out;
  const r = rectOf(root), cy = r.y + r.h / 2, ks = open(root);
  let right = ks, left: TreeNode[] = [];
  if (dir === "left") [right, left] = [[], ks];
  else if (dir === "balanced") {
    const total = ks.reduce((s, k) => s + span(k), 0);
    let acc = 0, cut = ks.length;
    for (let i = 0; i < ks.length; i++) { acc += span(ks[i]); if (acc >= total / 2) { cut = i + 1; break; } }
    [right, left] = [ks.slice(0, cut), ks.slice(cut)];
  }
  column(right, r.x + r.w + HGAP, cy, 1);
  column(left, r.x - HGAP, cy, -1);
  return out;
}

// ── Layout check ──────────────────────────────────────────────────────────────────────────────────────
// Problems a person would see, for the nodes an agent just touched: cards on top of each other, a card
// sitting inside a group it isn't in (it reads as a member), and groups overlapping. Group frames mirror
// the editor's: the members' box plus 28px, and 22px more on top for the label.
const CLOUD_PAD = 28, CLOUD_LABEL = 22;
export const groupFrame = (members: Rect[]): Rect | null => {
  const u = union(members);
  return u && { x: u.x - CLOUD_PAD, y: u.y - CLOUD_PAD - CLOUD_LABEL, w: u.w + CLOUD_PAD * 2, h: u.h + CLOUD_PAD * 2 + CLOUD_LABEL };
};
const cross = (a: Rect, b: Rect, slack = 2) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > slack && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > slack;

export function layoutWarnings(
  nodes: (Placed & { id: string })[], groups: { id: string; label: string | null; nodeIds: string[] }[],
  touched: Set<string>, name: (id: string) => string, max = 20,
): string[] {
  const rects = new Map(nodes.map((n) => [n.id, rectOf(n)]));
  const out: string[] = [];
  const ids = [...rects.keys()];
  for (let i = 0; i < ids.length && out.length < max; i++) for (let j = i + 1; j < ids.length && out.length < max; j++) {
    const a = ids[i], b = ids[j];
    if ((touched.has(a) || touched.has(b)) && cross(rects.get(a)!, rects.get(b)!)) out.push(`${name(a)} overlaps ${name(b)}`);
  }
  const frames = groups.map((g) => ({ g, f: groupFrame(g.nodeIds.map((id) => rects.get(id)).filter((r): r is Rect => !!r)) }));
  const gname = (g: { id: string; label: string | null }) => `group "${g.label ?? "(unlabelled)"}" [${g.id}]`;
  for (const { g, f } of frames) {
    if (!f) continue;
    const mine = new Set(g.nodeIds), hot = g.nodeIds.some((id) => touched.has(id));
    for (const [id, r] of rects) {
      if (out.length >= max) break;
      if (!mine.has(id) && (hot || touched.has(id)) && cross(f, r)) out.push(`${name(id)} sits inside ${gname(g)} but isn't in it`);
    }
  }
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length && out.length < max; j++) {
    const a = frames[i], b = frames[j];
    const hot = [...a.g.nodeIds, ...b.g.nodeIds].some((id) => touched.has(id));
    if (hot && a.f && b.f && cross(a.f, b.f)) out.push(`${gname(a.g)} overlaps ${gname(b.g)}`);
  }
  return out;
}

// `arrange`: the tidy tree, plus tidying up after it so the result reads cleanly. A group's members that
// aren't in the tree join the rest of their group, and anything the new layout lands on (with its whole
// group, so groups stay together) moves aside as one block to the nearest free spot.
export function arrangeBranch(
  nodes: TreeNode[], groups: { id: string; nodeIds: string[] }[], rootId: string, dir: "right" | "left" | "balanced",
): Map<string, { x: number; y: number }> {
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const id of g.nodeIds) groupOf.set(id, g.id);
  const moves = tidyTree(nodes, rootId, dir, groupOf);
  const now = () => nodes.map((n) => (moves.has(n.id) ? { ...n, ...moves.get(n.id)! } : n));
  const mine = new Set([rootId, ...moves.keys()]);
  const rectNow = (id: string) => rectOf(now().find((n) => n.id === id)!);

  for (const g of groups) {
    const inTree = g.nodeIds.filter((id) => mine.has(id));
    if (!inTree.length) continue;
    for (const id of g.nodeIds) {
      const n = nodes.find((x) => x.id === id);
      if (!n || mine.has(id)) continue;
      const r = rectOf(n), others = now().filter((x) => x.id !== id).map(rectOf);
      moves.set(id, findSpot(others, union(inTree.map(rectNow)), "below", r.w, r.h));
      mine.add(id);
    }
  }

  const memberOf = new Map<string, string[]>();
  for (const g of groups) for (const id of g.nodeIds) memberOf.set(id, g.nodeIds);
  const ours = [...mine].map(rectNow);
  const frames = groups.filter((g) => g.nodeIds.length && g.nodeIds.every((id) => mine.has(id))).map((g) => groupFrame(g.nodeIds.map(rectNow))!).filter(Boolean);
  const hit = new Set<string>();
  for (const n of now()) {
    if (mine.has(n.id)) continue;
    const r = rectOf(n);
    if ([...ours, ...frames].some((o) => overlaps(r, o))) for (const id of memberOf.get(n.id) ?? [n.id]) if (!mine.has(id)) hit.add(id);
  }
  if (!hit.size) return moves;
  const block = union([...hit].map(rectNow))!;
  const occupied = [
    ...now().filter((n) => !hit.has(n.id)).map(rectOf),
    ...groups.filter((g) => !g.nodeIds.some((id) => hit.has(id))).map((g) => groupFrame(g.nodeIds.map((id) => now().find((n) => n.id === id)).filter(Boolean).map((n) => rectOf(n!)))).filter((f): f is Rect => !!f),
  ];
  // The free spot closest to where the block was, looking out from the arranged area on every side.
  const area = union([...ours, ...frames])!;
  const spots = (["below", "right", "left", "above"] as Dir[]).map((d) => findSpot(occupied, area, d, block.w, block.h));
  const best = spots.sort((a, b) => Math.hypot(a.x - block.x, a.y - block.y) - Math.hypot(b.x - block.x, b.y - block.y))[0];
  for (const id of hit) {
    const r = rectNow(id);
    moves.set(id, { x: Math.round(r.x + best.x - block.x), y: Math.round(r.y + best.y - block.y) });
  }
  return moves;
}
