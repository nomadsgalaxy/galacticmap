// A board as readable text for an AI agent: what's in each group and area, mind-map nesting, connectors and
// variables, with every node's id so the agent can act on it. Pure (no DB), so it's testable on its own.
import type { SnapshotNode, SnapshotEdge } from "./types";
import type { GroupSnapshot } from "./board-service";
import { rectOf, union, clusters } from "./board-layout";
import { scanVariablesTyped, cellForEval, formatVar, aggregate, renderTrackerLine, type VarMap, type VarUnits } from "./variables";
import { evaluateCellDisplay, parseRef } from "../(editor)/boards/[id]/_components/nodes/sheetFormula";

export type OutlineBoard = { title: string; updatedAt: string; nodes: SnapshotNode[]; edges: SnapshotEdge[]; groups: GroupSnapshot[] };

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
// Markdown → plain-ish text: keep link text, drop formatting marks.
const plain = (md: string) => md.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>~|]/g, "");
const str = (v: unknown) => (typeof v === "string" ? v : "");

type Ctx = { vars: VarMap; units: VarUnits };

function content(n: SnapshotNode, ctx: Ctx): string {
  const d = n.data;
  switch (n.type) {
    case "text": return `"${clip(plain(str(d.text)), 160)}"`;
    case "swatch": return `color ${str(d.hex) || "?"}`;
    case "link": return [str(d.title) && `"${clip(str(d.title), 80)}"`, str(d.url)].filter(Boolean).join(" ") || "(empty link)";
    case "image": return str(d.alt) ? `"${clip(str(d.alt), 120)}"` : "(no description)";
    case "tracker": {
      const lines = Array.isArray(d.lines) ? (d.lines as string[]) : [];
      const shown = lines.slice(0, 6).map((l) => renderTrackerLine(l, ctx.vars, ctx.units)).join(" | ");
      return [str(d.title) && `"${str(d.title)}"`, shown || "(auto-lists every variable)"].filter(Boolean).join(": ");
    }
    case "spreadsheet": {
      const cells = (d.cells ?? {}) as Record<string, string>;
      const get = (ref: string) => cellForEval(cells[ref] ?? "");
      const filled = Object.keys(cells)
        .filter((k) => cells[k] !== "" && parseRef(k))
        .sort((a, b) => { const p = parseRef(a)!, q = parseRef(b)!; return p.row - q.row || p.col - q.col; });
      const shown = filled.slice(0, 12).map((k) => `${k}=${clip(evaluateCellDisplay(get(k), get, ctx.vars, ctx.units), 30)}`);
      return `${d.rows ?? 4}×${d.cols ?? 4} sheet` + (shown.length ? `: ${shown.join(", ")}${filled.length > 12 ? `, … (${filled.length} cells)` : ""}` : " (empty)");
    }
  }
  return "";
}

function nodeLine(n: SnapshotNode, ctx: Ctx): string {
  const d = n.data;
  const tags = Array.isArray(d.tags) && d.tags.length ? " " + (d.tags as string[]).map((t) => `#${t}`).join(" ") : "";
  const notes = str(d.notes) ? ` — notes: "${clip(str(d.notes), 80)}"` : "";
  const credit = d.credit && typeof d.credit === "object" ? ` (added by ${str((d.credit as { name?: unknown }).name)})` : "";
  return `[${n.id}] ${n.type}: ${content(n, ctx)}${tags}${notes}${credit} @(${Math.round(n.x)},${Math.round(n.y)})`;
}

// Nodes listed as an indented mind-map tree: a node whose parent is in the same section nests under it.
function treeLines(nodes: SnapshotNode[], ctx: Ctx): string[] {
  const ids = new Set(nodes.map((n) => n.id)), kids = new Map<string, SnapshotNode[]>();
  const order = (a: SnapshotNode, b: SnapshotNode) => a.y - b.y || a.x - b.x;
  for (const n of nodes) if (n.parentId && ids.has(n.parentId)) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const out: string[] = [], seen = new Set<string>();
  const walk = (n: SnapshotNode, depth: number) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const orphan = n.parentId && !ids.has(n.parentId) ? ` (child of [${n.parentId}])` : "";
    out.push(`${"  ".repeat(depth)}- ${nodeLine(n, ctx)}${orphan}`);
    for (const k of (kids.get(n.id) ?? []).sort(order)) walk(k, depth + 1);
  };
  for (const n of nodes.filter((x) => !x.parentId || !ids.has(x.parentId)).sort(order)) walk(n, 0);
  for (const n of nodes) walk(n, 0); // anything left over (a parent cycle) still gets listed
  return out;
}

export function outlineText(board: OutlineBoard, maxChars = 24000): string {
  const { vars, units } = scanVariablesTyped(board.nodes);
  const ctx: Ctx = { vars, units };
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? `${clip(content(n, ctx), 50)} [${id}]` : `[${id}]`;
  };

  const head = [
    `# ${board.title}`,
    `${board.nodes.length} nodes · ${board.edges.length} connectors · ${board.groups.length} groups · ${Object.keys(vars).length} variables · updated ${board.updatedAt.slice(0, 10)}`,
    "Each line is [id] type: content #tags @(x,y). Indented lines are mind-map children. Use the ids with apply_changes.",
    "",
  ];
  const body: string[] = [];

  // Groups first (a node in several groups is listed under the first), then ungrouped nodes by area.
  const placed = new Set<string>();
  for (const g of board.groups) {
    const members = g.nodeIds.map((id) => byId.get(id)).filter((n): n is SnapshotNode => !!n && !placed.has(n.id));
    members.forEach((n) => placed.add(n.id));
    const tags = g.tags.length ? " " + g.tags.map((t) => `#${t}`).join(" ") : "";
    body.push(`## Group "${g.label ?? "(unlabelled)"}" [${g.id}]${g.color ? ` ${g.color}` : ""}${tags} — ${members.length} nodes`, ...treeLines(members, ctx), "");
  }
  const loose = board.nodes.filter((n) => !placed.has(n.id));
  const areas = clusters(loose, rectOf).sort((a, b) => {
    const p = union(a.map(rectOf))!, q = union(b.map(rectOf))!;
    return p.y - q.y || p.x - q.x;
  });
  for (const area of areas) {
    const r = union(area.map(rectOf))!;
    const title = board.groups.length || areas.length > 1 ? `## Ungrouped area around (${Math.round(r.x)},${Math.round(r.y)}) — ${area.length} nodes` : "## Nodes";
    body.push(title, ...treeLines(area, ctx), "");
  }

  if (board.edges.length) {
    body.push("## Connectors");
    for (const e of board.edges) body.push(`- ${label(e.source)} → ${label(e.target)}${e.label ? ` "${e.label}"` : ""} [${e.id}]`);
    body.push("");
  }
  const names = Object.keys(vars);
  if (names.length) {
    body.push("## Variables");
    for (const name of names) {
      const a = aggregate(vars[name]);
      body.push(`- $${name}: sum ${formatVar(a.sum, units[name])}, ${a.count} value${a.count === 1 ? "" : "s"}${units[name] ? ` (${units[name] === "cur" ? "money" : units[name]})` : ""}`);
    }
  }
  if (!board.nodes.length) body.push("(This board is empty.)");

  // Keep within budget: cut whole lines and say how much was left out.
  const out = [...head];
  let size = out.join("\n").length;
  for (let i = 0; i < body.length; i++) {
    if (size + body[i].length + 1 > maxChars) {
      out.push(`… truncated (${body.length - i} more lines). Use get_board for the full data.`);
      break;
    }
    out.push(body[i]);
    size += body[i].length + 1;
  }
  return out.join("\n").trimEnd();
}
