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

const colIndex = (letters: string) => parseRef(letters + "1")!.col;

export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  // Leave "string literals" untouched: shift only the parts between them.
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.replace(TOKEN, (m, ...g: (string | undefined)[]) => {
    const [cAbsA, colA, rAbsA, rowA, cAbsB, colB, rAbsB, rowB, rgAbs1, rgCol1, rgAbs2, rgCol2] = g;
    const letters = colA ?? colB, digits = rowA ?? rowB;
    if (letters && digits) {
      const cAbs = (cAbsA ?? cAbsB) === "$", rAbs = (rAbsA ?? rAbsB) === "$";
      const col = colIndex(letters) + (cAbs ? 0 : dCol), row = Number(digits) - 1 + (rAbs ? 0 : dRow);
      if (col < 0 || row < 0) return "#REF!";
      return `${cAbs ? "$" : ""}${colName(col)}${rAbs ? "$" : ""}${row + 1}`;
    }
    if (rgCol1 && rgCol2) {
      const shift = (abs: string | undefined, letters: string) => {
        const col = colIndex(letters) + (abs === "$" ? 0 : dCol);
        return col < 0 ? null : `${abs ?? ""}${colName(col)}`;
      };
      const a = shift(rgAbs1, rgCol1), b = shift(rgAbs2, rgCol2);
      return a && b ? `${a}:${b}` : "#REF!";
    }
    return m; // a $variable or a word: unchanged
  }))).join("");
}

// What a cell's raw text becomes when copied dRow rows down / dCol columns right.
export function shiftCell(raw: string, dRow: number, dCol: number): string {
  if (raw.trimStart().startsWith("=")) return raw.replace(/^(\s*=)([\s\S]*)$/, (_m, p: string, e: string) => p + shiftFormula(e, dRow, dCol));
  if (cellOutput(raw)) return raw.replace(/^(\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*)([\s\S]*)$/, (_m, p: string, e: string) => p + shiftFormula(e, dRow, dCol));
  return raw; // plain values copy as they are
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
