// Excel-style fill: copying a cell into other cells, with formula references shifted by the distance
// moved. Relative refs move (A1 → A2 one row down); $-anchored parts stay ($A$1, $A1, A$1). Text in
// "quotes", $variables and function names are left alone. Pure, tested in scripts/test-sheetformula.mjs.
import { parseRef, colName, refName } from "./sheetFormula";
import { cellOutput } from "../../../../../lib/variables";

// One pass over the formula: a cell ref (A1, $A$1, a$1), a whole-column range (A:C), a $variable, or a
// word (function name / TRUE). Only the first two get shifted; matching the others stops their letters
// being mistaken for refs. "$" refs must be upper-case, like the tokenizer, so "$cost1" stays a variable.
const TOKEN =
  /(?<![A-Za-z0-9_.$])(?:(\$)([A-Z]{1,3})(\$?)(\d+)|()([A-Za-z]{1,3})(\$?)(\d+))(?![A-Za-z0-9_.(])|(?<![A-Za-z0-9_.$])(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.(])|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_.]*/g;

// A cell range (B2:B9), matched first so each end knows which end it is.
const END = String.raw`(?:\$[A-Z]{1,3}|[A-Za-z]{1,3})\$?\d+`;
const RANGE = new RegExp(String.raw`((?<![A-Za-z0-9_.$])${END}:${END}(?![A-Za-z0-9_.(]))`);

const colIndex = (letters: string) => parseRef(letters + "1")!.col;

// Where a ref points after an edit: the new 0-based index, or null when its row/column is gone (#REF!).
// `side` says which end of a range the ref is, so a deletion can pull that end inward instead.
type Side = "start" | "end" | undefined;
type MapIndex = (index: number, abs: boolean, side?: Side) => number | null;

// Rewrite every cell ref and whole-column range in a formula through `mapRow`/`mapCol`.
function mapRefs(formula: string, mapRow: MapIndex, mapCol: MapIndex): string {
  const cell = (side: Side) => (m: string, ...g: (string | undefined)[]) => {
    const [cAbsA, colA, rAbsA, rowA, cAbsB, colB, rAbsB, rowB, rgAbs1, rgCol1, rgAbs2, rgCol2] = g;
    const letters = colA ?? colB, digits = rowA ?? rowB;
    if (letters && digits) {
      const cAbs = (cAbsA ?? cAbsB) === "$", rAbs = (rAbsA ?? rAbsB) === "$";
      const col = mapCol(colIndex(letters), cAbs, side), row = mapRow(Number(digits) - 1, rAbs, side);
      if (col == null || row == null || col < 0 || row < 0) return "#REF!";
      return `${cAbs ? "$" : ""}${colName(col)}${rAbs ? "$" : ""}${row + 1}`;
    }
    if (rgCol1 && rgCol2) {
      const one = (abs: string | undefined, letters: string, end: Side) => {
        const col = mapCol(colIndex(letters), abs === "$", end);
        return col == null || col < 0 ? null : col;
      };
      const a = one(rgAbs1, rgCol1, "start"), b = one(rgAbs2, rgCol2, "end");
      // Both ends pulled past each other: every column of the range was deleted.
      if (a == null || b == null || (a > b && colIndex(rgCol1) <= colIndex(rgCol2))) return "#REF!";
      return `${rgAbs1 ?? ""}${colName(a)}:${rgAbs2 ?? ""}${colName(b)}`;
    }
    return m; // a $variable or a word: unchanged
  };
  const range = (r: string) => {
    const [a, b] = r.split(":");
    const ma = a.replace(TOKEN, cell("start")), mb = b.replace(TOKEN, cell("end"));
    const pa = parseRef(ma.replaceAll("$", "")), pb = parseRef(mb.replaceAll("$", ""));
    const oa = parseRef(a.replaceAll("$", ""))!, ob = parseRef(b.replaceAll("$", ""))!;
    if (!pa || !pb) return "#REF!";
    // Ends that crossed over (and weren't written that way) mean the whole range was deleted.
    if ((pa.row > pb.row && oa.row <= ob.row) || (pa.col > pb.col && oa.col <= ob.col)) return "#REF!";
    return `${ma}:${mb}`;
  };
  // Leave "string literals" untouched: rewrite only the parts between them; ranges first, then lone refs.
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.split(RANGE)
    .map((piece, j) => (j % 2 ? range(piece) : piece.replace(TOKEN, cell(undefined)))).join(""))).join("");
}

export const shiftFormula = (formula: string, dRow: number, dCol: number) =>
  mapRefs(formula, (r, abs) => (abs ? r : r + dRow), (c, abs) => (abs ? c : c + dCol));

// Apply `f` to the formula part of a cell ("=…" or "$Name = …"); plain values pass through.
function mapCellFormula(raw: string, f: (formula: string) => string): string {
  if (raw.trimStart().startsWith("=")) return raw.replace(/^(\s*=)([\s\S]*)$/, (_m, p: string, e: string) => p + f(e));
  if (cellOutput(raw)) return raw.replace(/^(\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*)([\s\S]*)$/, (_m, p: string, e: string) => p + f(e));
  return raw;
}

// What a cell's raw text becomes when copied dRow rows down / dCol columns right.
export const shiftCell = (raw: string, dRow: number, dCol: number) => mapCellFormula(raw, (e) => shiftFormula(e, dRow, dCol));

// Insert (count > 0) or delete (count < 0) whole rows or columns at `at` (0-based), like Excel: cells
// below/right of it move, and every formula's refs follow their cells, $-anchored or not, so a row
// inserted inside SUM(B2:B9) makes it SUM(B2:B10). Deleting a range's first or last line shrinks it;
// a lone ref into a deleted line, or a range with every line deleted, becomes #REF!.
export function insertLines(cells: Record<string, string>, axis: "row" | "col", at: number, count: number): Record<string, string> {
  const gone = (i: number) => count < 0 && i >= at && i < at - count;
  const move: MapIndex = (i, _abs, side) =>
    i < at ? i : gone(i) ? (side === "start" ? at : side === "end" ? at - 1 : null) : i + count;
  const keep: MapIndex = (i) => i;
  const [mapRow, mapCol] = axis === "row" ? [move, keep] : [keep, move];
  const next: Record<string, string> = {};
  for (const [ref, raw] of Object.entries(cells)) {
    const p = parseRef(ref);
    if (!p) continue;
    const row = mapRow(p.row, false), col = mapCol(p.col, false);
    if (row == null || col == null) continue; // the cell was in a deleted line
    next[refName(col, row)] = mapCellFormula(raw, (e) => mapRefs(e, mapRow, mapCol));
  }
  return next;
}

export type CellRange = { r0: number; c0: number; r1: number; c1: number };

// The range a fill drag covers: from the source cell to the hovered one, along whichever axis moved
// further (Excel fills a column or a row, never a diagonal block from one cell).
export function fillRange(src: string, over: string): CellRange | null {
  const s = parseRef(src), o = parseRef(over);
  if (!s || !o) return null;
  return Math.abs(o.row - s.row) >= Math.abs(o.col - s.col)
    ? { r0: Math.min(s.row, o.row), r1: Math.max(s.row, o.row), c0: s.col, c1: s.col }
    : { r0: s.row, r1: s.row, c0: Math.min(s.col, o.col), c1: Math.max(s.col, o.col) };
}

export const inRange = (g: CellRange, row: number, col: number) => row >= g.r0 && row <= g.r1 && col >= g.c0 && col <= g.c1;

// Copy `src` into every other cell of the range. An empty source clears the targets.
export function fillCells(cells: Record<string, string>, src: string, g: CellRange): Record<string, string> {
  const s = parseRef(src)!, raw = cells[src] ?? "", next = { ...cells };
  for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
    if (r === s.row && c === s.col) continue;
    const ref = refName(c, r);
    if (raw.trim() === "") delete next[ref];
    else next[ref] = shiftCell(raw, r - s.row, c - s.col);
  }
  return next;
}
