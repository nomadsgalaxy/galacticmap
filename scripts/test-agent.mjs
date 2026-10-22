// Self-check for agent placement + the board outline. Run: npx tsx scripts/test-agent.mjs
import { findSpot, sizeOf, rectOf, union, clusters, textSize, tidyTree, layoutWarnings } from "../app/lib/board-layout.ts";
import { outlineText, imageCaption } from "../app/lib/board-outline.ts";
import { snapshotSvg } from "../app/lib/board-snapshot.ts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  ✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const ok = (name, cond) => eq(name, !!cond, true);
const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// --- sizes ---
eq("empty text card", sizeOf("text"), { w: 160, h: 39 });
// Text cards size to their content, like the editor (calibrated in the browser e2e to within ~6%).
const list = textSize({ text: "Packing\n- one\n- two\n- three\n- four\n- five" });
ok("a checklist card is tall", list.h > 120);
ok("a long paragraph wraps at 280", textSize({ text: "word ".repeat(80) }).w === 280 && textSize({ text: "word ".repeat(80) }).h > 150);
ok("bigger font, bigger card", textSize({ text: "Title", fontSize: 28 }).h > textSize({ text: "Title" }).h);
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

// --- image captions: a file-name alt isn't a caption ---
eq("file name alt", imageCaption("image.png"), { caption: "", fileName: "image.png" });
eq("camera file name", imageCaption("IMG_2041.JPEG"), { caption: "", fileName: "IMG_2041.JPEG" });
eq("real caption kept", imageCaption("Sunset over the Tagus"), { caption: "Sunset over the Tagus", fileName: "" });
eq("caption that mentions a file isn't a file name", imageCaption("Logo, see brand.png\nfor the source").caption !== "", true);
eq("missing alt", imageCaption(undefined), { caption: "", fileName: "" });
const pics = outlineText({ ...board, groups: [], edges: [], nodes: [
  { id: "p1", type: "image", parentId: null, x: 0, y: 0, width: null, height: null, data: { assetId: "a", alt: "image.png" } },
  { id: "p2", type: "image", parentId: null, x: 300, y: 0, width: null, height: null, data: { assetId: "b", alt: "Tram 28" } },
  { id: "p3", type: "image", parentId: null, x: 600, y: 0, width: null, height: null, data: { assetId: "c" } },
] });
ok("outline flags a file-name alt", pics.includes("[p1] image: (no caption, file image.png; view_image shows it)"));
ok("outline quotes a real caption", pics.includes('[p2] image: "Tram 28"'));
ok("outline flags a missing alt", pics.includes("[p3] image: (no caption; view_image shows it)"));

// --- snapshot picture ---
const snap = snapshotSvg({ ...board, nodes: [...board.nodes, { id: "img", type: "image", parentId: null, x: 900, y: 0, width: 200, height: 100, data: { assetId: "a1", alt: "<b>" } }] }, { images: new Map([["a1", "data:image/jpeg;base64,AAAA"]]), width: 800 });
ok("snapshot is an 800px svg", snap.svg.startsWith("<svg") && snap.svg.includes('width="800"'));
eq("snapshot legend numbers every node", snap.legend.length, board.nodes.length + 1);
ok("snapshot legend carries ids", snap.legend.some((l) => l.includes("[n1] text: Lisbon trip")));
ok("snapshot embeds image thumbnails", snap.svg.includes('href="data:image/jpeg;base64,AAAA"'));
const risky = snapshotSvg({ ...board, nodes: [{ id: "x", type: "text", parentId: null, x: 0, y: 0, width: null, height: null, data: { text: 'a <script> & "b"' } }] });
ok("snapshot escapes text", !risky.svg.includes("<script") && risky.svg.includes("&#60;script &#38; &#34;b&#34;"));
ok("snapshot draws groups and swatches", snap.svg.includes("#1d4ed8"));
const t0 = Date.now();
const huge = snapshotSvg({ ...board, groups: [], edges: [], nodes: [{ id: "s", type: "spreadsheet", parentId: null, x: 0, y: 0, width: 400, height: 300, data: { rows: 1e8, cols: 1e6, cells: { A1: "x" } } }] });
ok("snapshot clamps a huge sheet to the editor's 50×26", Date.now() - t0 < 2000 && (huge.svg.match(/<line /g) ?? []).length === 50 + 26);
const focused = snapshotSvg(board, { region: { x: -50, y: -50, w: 300, h: 200 } });
ok("snapshot region crops the legend", focused.legend.length > 0 && focused.legend.length < board.nodes.length);

// --- tidy mind-map layout ---
const T = (id, parentId, text, x = 0, y = 0, extra = {}) => ({ id, parentId, type: "text", x, y, width: null, height: null, data: { text }, ...extra });
const tree = [
  T("root", null, "Trip", 1000, 1000),
  ...["Flights", "Hotels", "Packing\n- a\n- b\n- c\n- d", "Budget", "Events"].map((t, i) => T(`c${i}`, "root", t, 0, i * 10)),
  T("g0", "c2", "Suits"), T("g1", "c2", "Shoes", 0, 5),
  T("hid", "c4", "hidden", 7, 7), T("other", null, "unrelated", -5000, -5000),
];
tree.find((n) => n.id === "c4").collapsed = true;
const placed = (pos) => tree.map((n) => (pos.has(n.id) ? { ...n, ...pos.get(n.id) } : n));
const bal = tidyTree(tree, "root", "balanced"), after = placed(bal);
const rect = (id) => rectOf(after.find((n) => n.id === id));
ok("root stays put", !bal.has("root"));
ok("unrelated nodes untouched", !bal.has("other"));
ok("collapsed branch keeps hidden children", !bal.has("hid"));
const laid = after.filter((n) => n.id === "root" || bal.has(n.id)).map((n) => rectOf(n));
ok("no overlaps in the tree", laid.every((a, i) => laid.every((b, j) => i === j || !hits(a, b))));
ok("balanced puts children on both sides", [...bal.keys()].some((id) => rect(id).x > 1000) && [...bal.keys()].some((id) => rect(id).x < 1000));
ok("left children sit left of the root", ["c3", "c4"].every((id) => rect(id).x + rect(id).w <= 1000 - 80));
ok("siblings keep their order", rect("c0").y < rect("c1").y && rect("c1").y < rect("c2").y);
ok("grandchildren further out", rect("g0").x > rect("c2").x + rect("c2").w);
const one = tidyTree(tree, "root", "right");
ok("right puts every child right", ["c0", "c1", "c2", "c3", "c4"].every((id) => one.get(id).x >= 1000 + rectOf(tree[0]).w));

// --- layout warnings ---
const nm = (id) => id;
const crowd = [T("a", null, "A", 0, 0), T("b", null, "B", 50, 10), T("c", null, "C", 1000, 0), T("d", null, "D", 400, 0)];
const w1 = layoutWarnings(crowd, [], new Set(["a"]), nm);
eq("overlap reported", w1, ["a overlaps b"]);
eq("untouched overlaps not reported", layoutWarnings(crowd, [], new Set(["c"]), nm), []);
const w2 = layoutWarnings(crowd, [{ id: "g", label: "G", nodeIds: ["c"] }, { id: "h", label: "H", nodeIds: ["d"] }], new Set(["c", "d"]), nm);
eq("no false alarms for separate groups", w2, []);
const inside = [T("m", null, "member", 0, 0), T("m2", null, "member", 0, 300), T("x", null, "stray", 0, 150)];
ok("a stray inside a group is reported", layoutWarnings(inside, [{ id: "g", label: "G", nodeIds: ["m", "m2"] }], new Set(["x"]), nm).some((w) => w.includes("isn't in it")));

console.log(`\nagent — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
