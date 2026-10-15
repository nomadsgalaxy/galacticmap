// Self-check for agent placement + the board outline. Run: npx tsx scripts/test-agent.mjs
import { findSpot, sizeOf, rectOf, union, clusters } from "../app/lib/board-layout.ts";
import { outlineText } from "../app/lib/board-outline.ts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  ✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const ok = (name, cond) => eq(name, !!cond, true);
const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// --- sizes ---
eq("text default size", sizeOf("text"), { w: 180, h: 70 });
eq("explicit size wins", sizeOf("text", 300, 40), { w: 300, h: 40 });
eq("spreadsheet size from grid", sizeOf("spreadsheet", null, null, { rows: 2, cols: 3 }), { w: 210, h: 66 });
eq("union", union([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }]), { x: 0, y: 0, w: 30, h: 15 });
eq("union empty", union([]), null);

// --- placement ---
eq("empty board → origin", findSpot([], null, "right", 180, 70), { x: 0, y: 0 });
const a = { x: 0, y: 0, w: 180, h: 70 };
eq("right of anchor", findSpot([a], a, "right", 180, 70), { x: 220, y: 0 });
eq("below anchor", findSpot([a], a, "below", 180, 70), { x: 0, y: 110 });
eq("left of anchor", findSpot([a], a, "left", 180, 70), { x: -220, y: 0 });
eq("above anchor", findSpot([a], a, "above", 180, 70), { x: 0, y: -110 });
const blocker = { x: 220, y: 0, w: 180, h: 70 };
const slid = findSpot([a, blocker], a, "right", 180, 70);
ok("slides past a node in the way", !hits({ ...slid, w: 180, h: 70 }, blocker) && slid.x === 220);
eq("no anchor → below whole board", findSpot([a, blocker], null, "right", 180, 70), { x: 0, y: 110 });
// Placing many nodes one after another never overlaps anything.
const occ = [a];
for (let i = 0; i < 40; i++) {
  const p = findSpot(occ, a, "right", 180, 70);
  const r = { ...p, w: 180, h: 70 };
  if (occ.some((o) => hits(r, o))) { ok(`placement ${i} overlaps`, false); break; }
  occ.push(r);
}
ok("40 placements, no overlaps", occ.length === 41);

// --- clusters ---
const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 2000, y: 2000 }];
eq("clusters split far-apart nodes", clusters(pts, (p) => ({ ...p, w: 100, h: 50 })).map((c) => c.length).sort(), [1, 2]);

// --- outline ---
const node = (id, type, x, y, data = {}, extra = {}) => ({ id, type, parentId: null, layout: "manual", collapsed: false, order: 0, x, y, width: null, height: null, zIndex: 0, data, ...extra });
const board = {
  title: "Trip plan",
  updatedAt: "2026-10-14T12:00:00.000Z",
  nodes: [
    node("n1", "text", 0, 0, { text: "# Lisbon **trip**", tags: ["travel"] }),
    node("n2", "text", 0, 120, { text: "Book flights" }, { parentId: "n1" }),
    node("n3", "swatch", 300, 0, { hex: "#1d4ed8" }),
    node("n4", "link", 3000, 3000, { url: "https://example.com", title: "Hotel" }),
    node("n5", "spreadsheet", 3000, 3300, { rows: 2, cols: 2, cells: { A1: "Nights", B1: "$rate($120)", A2: "Total", B2: "=B1*3" } }),
    node("n6", "tracker", 3400, 3300, { title: "Budget", lines: ["Rate: sum(rate)"] }),
  ],
  edges: [{ id: "e1", source: "n1", target: "n4", kind: "connector", type: "animated", animated: true, label: "stay", data: {} }],
  groups: [{ id: "g1", label: "Ideas", color: "#8b5cf6", tags: ["wip"], nodeIds: ["n1", "n2", "n3"] }],
};
const text = outlineText(board);
ok("outline has title", text.startsWith("# Trip plan"));
ok("outline has counts", text.includes("6 nodes · 1 connectors · 1 groups · 1 variables"));
ok("outline lists group with tags", text.includes('## Group "Ideas" [g1] #8b5cf6 #wip — 3 nodes'));
ok("outline strips markdown + shows tags", text.includes('[n1] text: "Lisbon trip" #travel @(0,0)'));
ok("outline nests mind-map children", text.includes('  - [n2] text: "Book flights"'));
ok("outline shows swatch", text.includes("[n3] swatch: color #1d4ed8"));
ok("outline shows link", text.includes('[n4] link: "Hotel" https://example.com'));
ok("outline computes spreadsheet cells (money var)", text.includes("B1=$120,") && text.includes("B2=$360.00"));
ok("outline renders tracker lines with units", text.includes('[n6] tracker: "Budget": Rate: $120.00'));
ok("outline lists connectors by content", text.includes('→ "Hotel" https://example.com [n4] "stay" [e1]'));
ok("outline lists variables with units", text.includes("- $rate: sum $120.00, 1 value (money)"));
ok("outline ungrouped area heading", text.includes("## Ungrouped area around (3000,3000)"));
const short = outlineText(board, 300);
ok("outline respects budget", short.length <= 400 && short.includes("truncated"));
ok("empty board", outlineText({ ...board, nodes: [], edges: [], groups: [] }).includes("(This board is empty.)"));

console.log(`\nagent — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
