// Board-global trackable variables — original work under the OpenCommunityLicense (no third-party
// formula/spreadsheet libraries). Pure TypeScript: NO React import, so this module is safe to import
// from both server route handlers AND client components.
//
// VARIABLE GRAMMAR v2 — token syntax:  $name(content)
//   name    = /[A-Za-z_][A-Za-z0-9_]*/   (case-sensitive)
//   content = any text WITHOUT parentheses  /[^()]*/
//   A token is a VARIABLE iff `content` contains a parseable number (see parseVarValue).
//     • DISPLAY  = the content VERBATIM   ($PricePer($40) → "$40", $UnitsReq(10) → "10", $cost(30) → "30")
//     • TRACKED  = the number parsed out of content (first /-?\d[\d,]*\.?\d*/, commas stripped, parseFloat)
//                  ("$40"→40, "$1,200.50"→1200.5, "2.5kg"→2.5, "-3"→-3, "10 units"→10)
//   A token whose content has NO number is NOT a variable: the literal $name(content) is left untouched
//   (not stripped, not tracked). This GENERALIZES v1 (numeric-only); $cost(30) still works identically.
//
// PER-NODE source: ANY node may carry data.varText (string, a template using this token syntax) and
//   data.showVars (boolean, default false). The board-global registry includes variables found in every
//   node's data.varText regardless of node type, in addition to text-node data.text and spreadsheet
//   data.cells values.
//
// REFERENCE syntax ($name, Sum/Avg/Min/Max/Count($name)) lives in sheetFormula.ts and is shared via
// evaluateExpr below, so server-side aggregation and the tracker node use ONE implementation.

import { evaluateExpr as evalExprImpl, evalTyped, formatValue, parseLiteral, type VarMap, type VarUnits, type Unit, type CellGetter } from "../(editor)/boards/[id]/_components/nodes/sheetFormula";

export type { VarMap, VarUnits };

// A spreadsheet cell can NAME its computed result as a board variable:  "$Name = <formula>"  — the cell
// shows the formula's result AND exports `Name` to the registry. Distinct from "$cost(30)" (a literal
// value) — the "=" (vs "(") after the name is what marks an output, and "=A1*B1" alone is just a formula.
const CELL_OUTPUT_RE = /^\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)$/;
export function cellOutput(raw: unknown): { name: string; expr: string } | null {
  if (typeof raw !== "string") return null;
  const m = CELL_OUTPUT_RE.exec(raw);
  return m ? { name: m[1], expr: m[2].trim() } : null;
}
// Normalize a raw cell for FORMULA evaluation: a named-output cell evaluates AS its formula (so other
// cells referencing it by ref compute its value), and a value cell reads as what it displays
// ("$cost(30)" → "30"), so =A1*2 works on it.
export function cellForEval(raw: string): string {
  const o = cellOutput(raw);
  return o ? "=" + o.expr : raw.trimStart().startsWith("=") ? raw : stripVarTokens(raw);
}

// GLOBAL regex matching one $name(content) token. Group 1 = name, group 2 = RAW content (no parens).
// Whether the token is a variable depends on parseVarValue(content), not on this regex alone.
export const VAR_DEF_RE = /\$([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)/g;

// Number embedded in a token's content: first /-?\d[\d,]*\.?\d*/ match, commas stripped, parseFloat.
// Returns null when content holds no number or the parse is NaN.
export function parseVarValue(content: string): number | null {
  if (typeof content !== "string") return null;
  const m = content.match(/-?\d[\d,]*\.?\d*/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

// Replace every variable token $name(content) with its content VERBATIM; leave non-variable tokens
// (content without a number) untouched. ("$PricePer($40) • $UnitsReq(10)" → "$40 • 10")
export function stripVarTokens(text: string): string {
  if (!text) return text;
  return text.replace(VAR_DEF_RE, (m, _name, content: string) =>
    parseVarValue(content) !== null ? content : m,
  );
}

// All variable tokens found in a single string, in order of appearance. Only tokens whose content
// yields a number are returned; value = parseVarValue(content).
// `cur` marks money content ($rate($20) → true), so the variable carries the currency unit.
export function scanText(text: string): { name: string; value: number; cur: boolean }[] {
  const out: { name: string; value: number; cur: boolean }[] = [];
  if (!text) return out;
  // Construct a per-call regex (VAR_DEF_RE is global/stateful) so matchAll starts from a fresh lastIndex.
  const re = new RegExp(VAR_DEF_RE.source, "g");
  for (const m of text.matchAll(re)) {
    const value = parseVarValue(m[2]);
    if (value !== null) out.push({ name: m[1], value, cur: parseLiteral(m[2])?.u === "cur" });
  }
  return out;
}

// Generic node shape — accepts BOTH editor-store nodes and public nodes.
type ScannableNode = {
  type?: string;
  data?: {
    text?: unknown;
    cells?: unknown;
    varText?: unknown;
    showVars?: unknown;
    [k: string]: unknown;
  };
};

// Board-wide variable registry: scan text nodes (data.text), spreadsheet cells (data.cells values), AND
// every node's data.varText (any node type), aggregating every variable token into { name: number[] }.
export function scanVariables(nodes: ScannableNode[] | null | undefined): VarMap {
  return scanVariablesTyped(nodes).vars;
}

// Same scan, plus each variable's unit: "cur" when a definition holds money ($rate($20)), or the unit
// of a named-output cell's result ($Total = $20*D2 → "cur"). A name takes the first unit seen.
export function scanVariablesTyped(nodes: ScannableNode[] | null | undefined): { vars: VarMap; units: VarUnits } {
  const vars: VarMap = {};
  const units: VarUnits = {};
  if (!nodes) return { vars, units };
  // Pass 1 — literal $name(value) tokens from text, varText, and spreadsheet cell values → base registry.
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    for (const { name, value, cur } of scanText(raw)) {
      (vars[name] ??= []).push(value);
      if (cur) units[name] ??= "cur";
    }
  };
  for (const node of nodes) {
    const data = node?.data;
    if (!data) continue;
    add(data.text);
    add(data.varText);
    const cells = data.cells;
    if (cells && typeof cells === "object") {
      for (const cell of Object.values(cells as Record<string, unknown>)) add(cell);
    }
  }
  // Pass 2 — spreadsheet named-output cells ("$Name = formula") → export the COMPUTED result. Evaluated
  // against the node's own grid + the pass-1 literal registry (`base`); output vars don't feed each
  // other (one level — avoids cross-output cycles). The result aggregates like any variable.
  const base: VarMap = { ...vars };
  const baseUnits: VarUnits = { ...units };
  for (const node of nodes) {
    if (node?.type !== "spreadsheet") continue;
    const cells = node.data?.cells;
    if (!cells || typeof cells !== "object") continue;
    const c = cells as Record<string, unknown>;
    const get: CellGetter = (ref) => { const r = c[ref]; return typeof r === "string" ? cellForEval(r) : ""; };
    for (const raw of Object.values(c)) {
      const o = cellOutput(raw);
      if (!o) continue;
      const v = evalTyped(o.expr, get, base, baseUnits);
      if (typeof v === "string" || !Number.isFinite(v.n)) continue;
      (vars[o.name] ??= []).push(v.n);
      if (v.u) units[o.name] ??= v.u;
    }
  }
  return { vars, units };
}

// A variable's number for display: "$40.00" for money, "2 hours" for a duration, else plain. After a
// literal "$" in a template ("Price: $sum(cost)") money stays a bare number so it doesn't print "$$".
export function formatVar(n: number, u: Unit = "", afterDollar = false): string {
  return !u || (u === "cur" && afterDollar) ? fmtNum(n) : formatValue({ n, u });
}

// Aggregate a list of values. Empty list → all zeros (avg of empty = 0).
export function aggregate(values: number[]): { sum: number; avg: number; min: number; max: number; count: number } {
  const count = values.length;
  if (count === 0) return { sum: 0, avg: 0, min: 0, max: 0, count: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return { sum, avg: sum / count, min: Math.min(...values), max: Math.max(...values), count };
}

// Evaluate a global-only reference expression against the registry. Shared with the spreadsheet/tracker
// engine so server + client agree exactly. Returns a number, "" for empty, or "#ERR"/"#CYCLE".
export function evaluateExpr(expr: string, vars: VarMap = {}): number | string {
  return evalExprImpl(expr, vars);
}

const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

// A tracker line is a TEMPLATE: literal text is kept and embedded computations are substituted inline, so
// "Price: $sum(ProjAPrice)" → "Price: $60" (the "$" is literal currency; sum(ProjAPrice) is computed).
// Two evaluated forms:
//   • a bare aggregate call  sum|avg|average|min|max|count(VarName)  (VarName bare or $-prefixed,
//     case-insensitive) → that variable's aggregate. The common case — matches the example.
//   • a { expr } block → the full reference expression via evaluateExpr (e.g. "{Sum($revenue)-Sum($cost)}"
//     or "{$cost*1.1}"), for arithmetic across variables.
// Everything else (incl. a literal "$") is left untouched.
const TRACKER_AGG_RE = /\b(sum|avg|average|min|max|count)\s*\(\s*\$?([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi;
export function renderTrackerLine(line: string, vars: VarMap = {}, units: VarUnits = {}): string {
  if (!line) return "";
  // 1) { expr } blocks → the full expression engine ($name refs + arithmetic).
  let out = line.replace(/\{([^{}]+)\}/g, (_m, expr: string, at: number, s: string) => {
    const v = evalTyped(expr.trim().replace(/^=/, ""), () => "", vars, units);
    return typeof v === "string" ? v : formatVar(v.n, v.u, s[at - 1] === "$");
  });
  // 2) bare aggregate calls → the named variable's aggregate.
  out = out.replace(TRACKER_AGG_RE, (_m, fn: string, name: string, at: number, s: string) => {
    const a = aggregate(vars[name] ?? []);
    const show = (n: number) => formatVar(n, units[name], s[at - 1] === "$");
    switch (fn.toLowerCase()) {
      case "sum": return show(a.sum);
      case "avg": case "average": return show(a.avg);
      case "min": return show(a.min);
      case "max": return show(a.max);
      default: return fmtNum(a.count); // count
    }
  });
  return out;
}
