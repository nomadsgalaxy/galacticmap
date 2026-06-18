// Minimal spreadsheet formula evaluator — original work under the OpenCommunityLicense (no third-party
// formula engine). Supports: plain numbers, text, and "=" formulas with cell refs (A1), ranges (A1:B3),
// + - * / and parentheses, unary +/-, and the functions SUM / AVERAGE (AVG) / MIN / MAX / COUNT.
// A recursive-descent parser (no eval), with cycle detection so A1=B1 / B1=A1 yields #CYCLE not a hang.

export type CellGetter = (ref: string) => string; // raw cell text for a ref like "A1" ("" when empty)

// Board-global trackable variables: a name maps to ALL its defined values across the board.
export type VarMap = Record<string, number[]>;

// "A1" → {col:0,row:0}. Column letters are base-26 (A..Z, AA, AB, …). Returns null if not a ref.
export function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = parseInt(m[2], 10) - 1;
  if (col < 1 || row < 0) return null;
  return { col: col - 1, row };
}

// 0 → "A", 25 → "Z", 26 → "AA".
export function colName(col: number): string {
  let s = "", c = col + 1;
  while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); }
  return s;
}
export const refName = (col: number, row: number): string => colName(col) + (row + 1);

// "A1:B3" → ["A1","A2","A3","B1",…]; a single ref → [ref]; junk → [].
function expandRange(token: string): string[] {
  const [a, b] = token.split(":");
  const pa = parseRef(a), pb = b !== undefined ? parseRef(b) : null;
  if (!pa) return [];
  if (!pb) return [refName(pa.col, pa.row)];
  const out: string[] = [];
  for (let c = Math.min(pa.col, pb.col); c <= Math.max(pa.col, pb.col); c++)
    for (let r = Math.min(pa.row, pb.row); r <= Math.max(pa.row, pb.row); r++)
      out.push(refName(c, r));
  return out;
}

type Tok = { t: "num" | "op" | "lp" | "rp" | "comma" | "ref" | "range" | "func" | "var"; v: string };

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "$") { // $name — a board-global variable reference (case-sensitive; name kept verbatim)
      let j = i + 1;
      if (j >= s.length || !/[A-Za-z_]/.test(s[j])) throw new Error("expected variable name after $");
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      toks.push({ t: "var", v: s.slice(i + 1, j) }); i = j; continue;
    }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i + 1;
      while (j < s.length && /[0-9.eE]/.test(s[j])) j++;
      toks.push({ t: "num", v: s.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
      const word = s.slice(i, j); i = j;
      let k = i; while (k < s.length && s[k] === " ") k++;
      if (s[k] === "(") { toks.push({ t: "func", v: word.toUpperCase() }); continue; } // FUNC(
      if (s[i] === ":") { // range A1:B3
        let m = i + 1;
        while (m < s.length && /[A-Za-z0-9]/.test(s[m])) m++;
        toks.push({ t: "range", v: word + ":" + s.slice(i + 1, m) }); i = m; continue;
      }
      toks.push({ t: "ref", v: word.toUpperCase() }); continue;
    }
    if ("+-*/".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    if (c === "(") { toks.push({ t: "lp", v: c }); i++; continue; }
    if (c === ")") { toks.push({ t: "rp", v: c }); i++; continue; }
    if (c === ",") { toks.push({ t: "comma", v: c }); i++; continue; }
    throw new Error("unexpected char: " + c);
  }
  return toks;
}

// Recursive descent: expr → term (±term)* ; term → factor (*|/ factor)* ; factor → number | ref |
// FUNC(args) | (expr) | ±factor. A bare range is only valid inside a function arg list.
function parse(toks: Tok[], resolve: (ref: string) => number, varValues: (name: string) => number[]): number {
  let p = 0;
  const peek = () => toks[p];
  const eat = () => toks[p++];

  const expr = (): number => {
    let v = term();
    while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = eat().v, r = term(); v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = eat().v, r = factor(); v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const factor = (): number => {
    const t = peek();
    if (!t) throw new Error("unexpected end");
    if (t.t === "op" && (t.v === "-" || t.v === "+")) { eat(); const f = factor(); return t.v === "-" ? -f : f; }
    if (t.t === "num") { eat(); const n = parseFloat(t.v); if (isNaN(n)) throw new Error("bad number"); return n; }
    if (t.t === "lp") { eat(); const v = expr(); if (!peek() || peek().t !== "rp") throw new Error("missing )"); eat(); return v; }
    if (t.t === "ref") { eat(); return resolve(t.v); }
    if (t.t === "var") { eat(); return varValues(t.v).reduce((a, b) => a + b, 0); } // bare $name = SUM of its values
    if (t.t === "func") return func();
    throw new Error("unexpected token: " + t.v);
  };
  const func = (): number => {
    const name = eat().v;
    if (!peek() || peek().t !== "lp") throw new Error("expected (");
    eat();
    const nums: number[] = [];
    if (peek() && peek().t !== "rp") {
      do {
        const t = peek();
        if (t && t.t === "range") { eat(); for (const ref of expandRange(t.v)) nums.push(resolve(ref)); }
        else if (t && t.t === "var") { eat(); for (const n of varValues(t.v)) nums.push(n); } // $name → ALL its values
        else nums.push(expr());
      } while (peek() && peek().t === "comma" && eat());
    }
    if (!peek() || peek().t !== "rp") throw new Error("missing )"); eat();
    switch (name) {
      case "SUM": return nums.reduce((a, b) => a + b, 0);
      case "AVERAGE": case "AVG": return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
      case "MIN": return nums.length ? Math.min(...nums) : 0;
      case "MAX": return nums.length ? Math.max(...nums) : 0;
      case "COUNT": return nums.length;
      default: throw new Error("unknown function: " + name);
    }
  };

  const result = expr();
  if (p !== toks.length) throw new Error("trailing tokens");
  if (!Number.isFinite(result)) throw new Error("non-finite");
  return result;
}

function evalBody(body: string, get: CellGetter, stack: Set<string>, vars: VarMap): number {
  const resolve = (ref: string): number => {
    if (stack.has(ref)) throw new Error("cycle");
    const raw = (get(ref) ?? "").trim();
    if (raw === "") return 0;
    if (raw[0] === "=") {
      stack.add(ref);
      try { return evalBody(raw.slice(1), get, stack, vars); } finally { stack.delete(ref); }
    }
    const n = Number(raw);
    return isNaN(n) ? 0 : n; // a text cell contributes 0 to arithmetic
  };
  const varValues = (name: string): number[] => vars[name] ?? []; // missing var → []
  return parse(tokenize(body), resolve, varValues);
}

// Compute a cell's DISPLAY value. Returns a number for a numeric/formula cell, the raw string for text,
// "" for empty, or "#ERR"/"#CYCLE" on a bad formula / circular reference.
// `vars` (optional) is the board-global variable registry referenced via $name inside "=" formulas.
export function evaluateCell(raw: string, get: CellGetter, vars: VarMap = {}): number | string {
  const s = (raw ?? "").trim();
  if (s === "") return "";
  if (s[0] !== "=") {
    const n = Number(s);
    return !isNaN(n) && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? n : raw;
  }
  try { return evalBody(s.slice(1), get, new Set(), vars); }
  catch (e) { return e instanceof Error && e.message === "cycle" ? "#CYCLE" : "#ERR"; }
}

// Evaluate a GLOBAL-ONLY expression (no spreadsheet cells) — used by tracker nodes and the server.
// $name references resolve against `vars`; a stray cell ref (e.g. A1) resolves to 0. A leading "="
// is tolerated. Returns a number, or "#ERR"/"#CYCLE" on a bad expression.
export function evaluateExpr(expr: string, vars: VarMap = {}): number | string {
  const s = (expr ?? "").trim().replace(/^=/, "");
  if (s === "") return "";
  try { return evalBody(s, () => "", new Set(), vars); } // no cells: every ref reads "" → 0
  catch (e) { return e instanceof Error && e.message === "cycle" ? "#CYCLE" : "#ERR"; }
}
