// A board drawn as an SVG picture for an AI agent: groups, connectors, mind-map links and every node with a
// numbered badge, plus a legend mapping each number to the node's id. Pure (no DB, no sharp), so it's testable
// on its own; the route rasterizes it. Only an approximation of the editor: fonts and wrapping are estimated.
import type { SnapshotNode } from "./types";
import { imageCaption, type OutlineBoard } from "./board-outline";
import { rectOf, union, type Rect } from "./board-layout";
import { scanVariablesTyped, cellForEval, renderTrackerLine, type VarMap, type VarUnits } from "./variables";
import { evaluateCellDisplay } from "../(editor)/boards/[id]/_components/nodes/sheetFormula";

export type SnapshotOptions = {
  /** World-space area to draw; defaults to the whole board. */
  region?: Rect;
  /** Output width in px (height follows the region's aspect, capped at 2x the width). */
  width?: number;
  /** assetId → data: URI of a thumbnail, for image nodes. Missing ones draw as a placeholder. */
  images?: Map<string, string>;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const plain = (md: string) => md.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>~|]/g, "").trim();
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
// Where the line from `from` toward r's center crosses r's border, so arrowheads land on the node's edge.
function borderPoint(r: Rect, from: { x: number; y: number }) {
  const c = center(r), dx = from.x - c.x, dy = from.y - c.y;
  const t = Math.min(dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// Greedy word wrap using an estimated glyph width; cuts with … when it runs out of lines.
function wrap(text: string, width: number, size: number, maxLines: number): string[] {
  const perLine = Math.max(4, Math.floor(width / (size * 0.56)));
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (next.length <= perLine) { line = next; continue; }
      if (line) out.push(line);
      line = word.length > perLine ? word.slice(0, perLine - 1) + "…" : word;
    }
    out.push(line);
  }
  const lines = out.filter((l, i) => l || (i > 0 && out[i - 1]));
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines));
  kept[kept.length - 1] = kept[kept.length - 1].replace(/.?$/, "…");
  return kept;
}

function textBlock(lines: string[], x: number, y: number, size: number, attrs = ""): string {
  return lines.map((l, i) => `<text x="${x}" y="${y + size + i * size * 1.3}" font-size="${size}"${attrs}>${esc(l)}</text>`).join("");
}

type Ctx = { vars: VarMap; units: VarUnits; images: Map<string, string> };

function card(r: Rect, fill = "#ffffff", stroke = "#d4d4d8") {
  return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
}

function drawNode(n: SnapshotNode, r: Rect, ctx: Ctx): string {
  const d = n.data, pad = 10, inner = r.w - pad * 2;
  const fits = (size: number) => Math.max(1, Math.floor((r.h - pad * 2) / (size * 1.3)));
  switch (n.type) {
    case "text": {
      const size = typeof d.fontSize === "number" ? d.fontSize : 14;
      return card(r) + textBlock(wrap(plain(str(d.text)), inner, size, fits(size)), r.x + pad, r.y + pad - 2, size);
    }
    case "swatch": {
      const hex = /^#[0-9a-f]{6}$/i.test(str(d.hex)) ? str(d.hex) : "#6d28d9";
      return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="${hex}" stroke="#00000033"/>`
        + `<rect x="${r.x + 6}" y="${r.y + r.h - 26}" width="72" height="20" rx="4" fill="#ffffffcc"/>`
        + `<text x="${r.x + 12}" y="${r.y + r.h - 11}" font-size="12" font-family="monospace">${esc(hex)}</text>`;
    }
    case "image": {
      const href = ctx.images.get(str(d.assetId));
      if (!href) return card(r, "#f4f4f5") + textBlock(wrap(`[image] ${imageCaption(d.alt).caption}`, inner, 12, fits(12)), r.x + pad, r.y + pad, 12, ' fill="#71717a"');
      const aspect = d.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet";
      const clip = `c${n.id.replace(/\W/g, "")}`;
      return `<clipPath id="${clip}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10"/></clipPath>`
        + `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="#f4f4f5"/>`
        + `<image href="${href}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" preserveAspectRatio="${aspect}" clip-path="url(#${clip})"/>`;
    }
    case "link": {
      let host = str(d.url);
      try { host = new URL(host).host; } catch { /* keep the raw text */ }
      const title = str(d.title) || host || "(empty link)";
      return card(r, "#ffffff", "#93c5fd") + textBlock(wrap(title, inner, 14, 2), r.x + pad, r.y + pad - 2, 14, ' font-weight="600"')
        + `<text x="${r.x + pad}" y="${r.y + r.h - pad}" font-size="11" fill="#2563eb">${esc(host)}</text>`;
    }
    case "tracker": {
      const lines = (Array.isArray(d.lines) ? (d.lines as string[]) : []).map((l) => renderTrackerLine(l, ctx.vars, ctx.units));
      return card(r, "#fffbeb", "#fcd34d") + textBlock(wrap([str(d.title), ...lines].filter(Boolean).join("\n") || "Tracker", inner, 13, fits(13)), r.x + pad, r.y + pad - 2, 13);
    }
    case "spreadsheet": {
      const cells = (d.cells ?? {}) as Record<string, string>;
      const rows = Number(d.rows ?? 4), cols = Number(d.cols ?? 4);
      const cw = (r.w - 30) / cols, rh = r.h / (rows + 1);
      const get = (ref: string) => cellForEval(cells[ref] ?? "");
      let s = card(r) + `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${rh}" fill="#f4f4f5"/>`;
      for (let c = 0; c < cols; c++) {
        const L = String.fromCharCode(65 + c), x = r.x + 30 + c * cw;
        s += `<line x1="${x}" y1="${r.y}" x2="${x}" y2="${r.y + r.h}" stroke="#e4e4e7"/><text x="${x + 4}" y="${r.y + rh - 6}" font-size="10" fill="#71717a">${L}</text>`;
        for (let row = 1; row <= rows; row++) {
          const raw = cells[`${L}${row}`];
          if (!raw) continue;
          const shown = evaluateCellDisplay(get(`${L}${row}`), get, ctx.vars, ctx.units);
          const max = Math.max(1, Math.floor((cw - 6) / 6));
          s += `<text x="${x + 3}" y="${r.y + rh * (row + 1) - 6}" font-size="10" font-family="monospace">${esc(shown.length > max ? shown.slice(0, max - 1) + "…" : shown)}</text>`;
        }
      }
      for (let row = 1; row <= rows; row++) s += `<line x1="${r.x}" y1="${r.y + rh * row}" x2="${r.x + r.w}" y2="${r.y + rh * row}" stroke="#e4e4e7"/>`;
      return s;
    }
  }
  return card(r);
}

export function snapshotSvg(board: OutlineBoard, opts: SnapshotOptions = {}): { svg: string; legend: string[]; region: Rect } {
  const { vars, units } = scanVariablesTyped(board.nodes);
  const ctx: Ctx = { vars, units, images: opts.images ?? new Map() };
  const rects = new Map(board.nodes.map((n) => [n.id, rectOf(n)]));
  const groupRect = (ids: string[]) => {
    const u = union(ids.map((id) => rects.get(id)).filter((r): r is Rect => !!r));
    return u && { x: u.x - 24, y: u.y - 40, w: u.w + 48, h: u.h + 64 };
  };
  const all = union([...rects.values(), ...board.groups.map((g) => groupRect(g.nodeIds)).filter((r): r is Rect => !!r)]) ?? { x: 0, y: 0, w: 800, h: 600 };
  const region = opts.region ?? { x: all.x - 40, y: all.y - 40, w: all.w + 80, h: all.h + 80 };
  const width = Math.round(opts.width ?? 1600);
  const height = Math.round(Math.min(width * 2, (width * region.h) / region.w));
  const hits = (r: Rect) => r.x < region.x + region.w && r.x + r.w > region.x && r.y < region.y + region.h && r.y + r.h > region.y;
  // Keep labels readable when zoomed far out: badges and edge labels scale up as the view shrinks.
  const k = Math.max(1, region.w / width);

  const parts: string[] = [];
  for (const g of board.groups) {
    const r = groupRect(g.nodeIds);
    if (!r || !hits(r)) continue;
    const c = g.color && /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : "#8b5cf6";
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="28" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="${2 * k}" stroke-dasharray="${8 * k} ${6 * k}"/>`
      + `<text x="${r.x + 16}" y="${r.y + 26 * Math.min(k, 3)}" font-size="${18 * Math.min(k, 3)}" font-weight="700" fill="${c}">${esc(g.label ?? "(unlabelled group)")}</text>`);
  }
  // Mind-map links: parent's right edge to child's left edge, as the editor's tree edges run.
  for (const n of board.nodes) {
    const a = n.parentId ? rects.get(n.parentId) : undefined, b = rects.get(n.id);
    if (!a || !b || (!hits(a) && !hits(b))) continue;
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
    parts.push(`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#a78bfa" stroke-width="${2.5 * k}"/>`);
  }
  for (const e of board.edges) {
    const a = rects.get(e.source), b = rects.get(e.target);
    if (!a || !b || (!hits(a) && !hits(b))) continue;
    const p = center(a), q = borderPoint(b, p);
    parts.push(`<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#64748b" stroke-width="${2 * k}" stroke-dasharray="${6 * k} ${4 * k}" marker-end="url(#arrow)"/>`);
    if (e.label) parts.push(`<text x="${(p.x + q.x) / 2}" y="${(p.y + q.y) / 2 - 6 * k}" font-size="${12 * k}" text-anchor="middle" fill="#334155" stroke="#ffffff" stroke-width="${4 * k}" paint-order="stroke">${esc(e.label)}</text>`);
  }

  const legend: string[] = [];
  const order = [...board.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const n of order) {
    const r = rects.get(n.id)!;
    if (!hits(r)) continue;
    const num = legend.length + 1;
    const d = n.data;
    const label = n.type === "text" ? plain(str(d.text)) : n.type === "image" ? imageCaption(d.alt).caption : n.type === "link" ? str(d.title) || str(d.url) : n.type === "swatch" ? str(d.hex) : str(d.title);
    legend.push(`${num} = [${n.id}] ${n.type}${label ? `: ${label.replace(/\s+/g, " ").slice(0, 60)}` : ""}`);
    const br = 11 * k;
    parts.push(drawNode(n, r, ctx)
      + `<circle cx="${r.x}" cy="${r.y}" r="${br}" fill="#18181b"/><text x="${r.x}" y="${r.y + br * 0.38}" font-size="${br}" font-weight="700" text-anchor="middle" fill="#ffffff">${num}</text>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${region.x} ${region.y} ${region.w} ${region.h}" preserveAspectRatio="xMidYMin meet" font-family="sans-serif" fill="#18181b">`
    + `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker></defs>`
    + `<rect x="${region.x}" y="${region.y}" width="${region.w}" height="${region.h}" fill="#fafaf9"/>`
    + parts.join("") + `</svg>`;
  return { svg, legend, region };
}
