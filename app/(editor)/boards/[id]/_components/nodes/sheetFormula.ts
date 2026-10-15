// Spreadsheet formula engine — original work under the OpenCommunityLicense (no third-party formula
// engine). Excel/Google Sheets compatible: "=" formulas with cell refs (A1, $A$1, ranges A1:B3, whole
// columns A:A), numbers, "text", TRUE/FALSE, the operators + - * / ^ & % and = <> < > <= >=, and ~200 Excel
// functions (the FN table below). Formulas parse to a tree first, so IF/IFERROR/CHOOSE only evaluate the
// branch they take, and cycle detection turns A1=B1 / B1=A1 into #CYCLE instead of a hang. Errors follow
// Excel (#DIV/0!, #VALUE!, #N/A, #NAME?, #NUM!, #REF!); "#ERR" means the formula itself doesn't parse.
//
// Typed values: literal cells are auto-detected as times ("11:15 PM", "23:15"), durations ("2 hours",
// "1h 30m", "45 min"), money ("$20", "$1,200.50"), dates ("10/14/2026", "2026-10-14"), percents ("15%"),
// plain numbers ("1,200") and TRUE/FALSE. Formulas carry the unit through: time − time = duration (wrapping
// past midnight), duration × money = money, date − date = days, and "$20" is a money literal (=$20*D2).
//
// Not supported: results that spill into neighbouring cells (FILTER, SORT, UNIQUE, SEQUENCE…; an array
// result shows its first value), other sheets, and LET/LAMBDA.

export type CellGetter = (ref: string) => string; // raw cell text for a ref like "A1" ("" when empty)

// Board-global trackable variables: a name maps to ALL its defined values across the board.
export type VarMap = Record<string, number[]>;

// "" = plain number, "time" = time of day in hours (0–24), "dur" = duration in hours, "cur" = dollars,
// "date" = Excel serial day (1970-01-01 = 25569; the fraction is the time of day).
export type Unit = "" | "time" | "dur" | "cur" | "date";
export type Val = { n: number; u: Unit };
// The unit each board variable carries (e.g. $rate($20) → "cur"); a missing name is a plain number.
export type VarUnits = Record<string, Unit>;
const plain = (n: number): Val => ({ n, u: "" });
const wrap24 = (h: number) => ((h % 24) + 24) % 24;

// Grid limits, shared with SpreadsheetNode. Whole-column refs (A:A) expand to this many rows.
export const SHEET_MAX_ROWS = 50, SHEET_MAX_COLS = 26;

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

// ── Dates ────────────────────────────────────────────────────────────────────────────────────────────
const EPOCH = 25569; // Excel serial of 1970-01-01
const serialFromYMD = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 864e5 + EPOCH; // month/day overflow rolls over
function ymd(serial: number) {
  const d = new Date(Math.round((Math.floor(serial) - EPOCH) * 864e5));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
}
function nowSerial(): number {
  const d = new Date();
  return serialFromYMD(d.getFullYear(), d.getMonth() + 1, d.getDate()) + (d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600) / 24;
}
// "10/14/2026", "10/14/26", "2026-10-14" → serial, or null.
function parseDate(s: string): number | null {
  let y: number, m: number, d: number, r: RegExpExecArray | null;
  if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(s))) {
    m = +r[1]; d = +r[2]; y = +r[3];
    if (r[3].length === 2) y += y < 30 ? 2000 : 1900; // Excel's two-digit-year rule
  } else if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else return null;
  const n = serialFromYMD(y, m, d), back = ymd(n);
  return back.y === y && back.m === m && back.d === d ? n : null; // rejects 2/30/2026
}

// Parse a literal (non-formula) cell into a typed number; null = text.
export function parseLiteral(raw: string): Val | null {
  const s = (raw ?? "").trim();
  if (NUM_RE.test(s)) return plain(Number(s));
  let m = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.exec(s); // 1,200 / 1,200.50
  if (m) return plain(Number(s.replace(/,/g, "")));
  m = /^(-?\d*\.?\d+)\s*%$/.exec(s);
  if (m) return plain(Number(m[1]) / 100);
  m = /^(-)?\$\s?(-)?(\d[\d,]*(?:\.\d*)?|\.\d+)$/.exec(s); // $20, -$5, $-5, $1,200.50
  if (m) return { n: (m[1] || m[2] ? -1 : 1) * Number(m[3].replace(/,/g, "")), u: "cur" };
  m = /^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(?:([ap])\.?\s?m\.?)?$/i.exec(s); // 11:15 PM, 23:15, 9am
  if (m && (m[2] !== undefined || m[4])) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0), sec = Number(m[3] ?? 0);
    if (min > 59 || sec > 59) return null;
    if (m[4]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[4].toLowerCase() === "p" ? 12 : 0); }
    else if (h > 23) return null;
    return { n: h + min / 60 + sec / 3600, u: "time" };
  }
  m = /^(?:(\d*\.?\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d*\.?\d+)\s*m(?:in(?:ute)?s?)?)?$/i.exec(s); // 2 hours, 1h 30m, 45 min
  if (m && (m[1] || m[2])) return { n: Number(m[1] ?? 0) + Number(m[2] ?? 0) / 60, u: "dur" };
  const day = parseDate(s);
  if (day !== null) return { n: day, u: "date" };
  const dt = /^(\S+)\s+(.+)$/.exec(s); // "10/14/2026 4:30 PM"
  if (dt) {
    const d = parseDate(dt[1]), t = d !== null ? parseLiteral(dt[2]) : null;
    if (d !== null && t?.u === "time") return { n: d + t.n / 24, u: "date" };
  }
  return null;
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

// Typed value → display text: "40", "$40.00", "1:15 AM", "2 hours 30 min", "10/14/2026".
export function formatValue(v: Val): string {
  if (v.u === "cur") {
    const abs = Math.abs(v.n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v.n < 0 ? "-$" : "$") + abs;
  }
  if (v.u === "time") {
    const mins = Math.round(wrap24(v.n) * 60) % 1440, h = Math.floor(mins / 60);
    return `${h % 12 || 12}:${String(mins % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  if (v.u === "dur") {
    const total = Math.round(Math.abs(v.n) * 60), h = Math.floor(total / 60), m = total % 60;
    const parts = [h ? `${h} hour${h === 1 ? "" : "s"}` : "", m ? `${m} min` : ""].filter(Boolean);
    return (v.n < 0 ? "-" : "") + (parts.join(" ") || "0 hours");
  }
  if (v.u === "date") {
    const { y, m, d } = ymd(v.n), frac = v.n - Math.floor(v.n), day = `${m}/${d}/${y}`;
    return frac > 1e-9 ? `${day} ${formatValue({ n: frac * 24, u: "time" })}` : day;
  }
  return fmtNum(v.n);
}

// Unit rules. A time used as an amount (× ÷) counts as a duration in hours; a date counts as a plain number.
const amount = (u: Unit): Unit => (u === "time" ? "dur" : u === "date" ? "" : u);
const asDays = (v: Val) => (v.u === "time" || v.u === "dur" ? v.n / 24 : v.n);
function addVals(a: Val, b: Val, sign: 1 | -1): Val {
  if (a.u === "date" || b.u === "date") {
    if (a.u === "date" && b.u === "date") return plain(a.n + sign * b.n); // date − date = days
    if (a.u === "date") return { n: a.n + sign * asDays(b), u: "date" }; // date ± days / duration / time
    return sign > 0 ? { n: asDays(a) + b.n, u: "date" } : plain(asDays(a) - b.n);
  }
  const n = a.n + sign * b.n;
  if (a.u === "time" && b.u === "time") return { n: sign < 0 ? wrap24(n) : n, u: "dur" }; // 1:15 AM − 11:15 PM = 2 hours
  if (a.u === "time" || b.u === "time") return { n: wrap24(n), u: "time" }; // time ± duration
  return { n, u: a.u || b.u };
}
function mulVals(a: Val, b: Val): Val {
  const ua = amount(a.u), ub = amount(b.u);
  return { n: a.n * b.n, u: ua === "cur" || ub === "cur" ? "cur" : ua || ub ? "dur" : "" };
}
function divVals(a: Val, b: Val): Val {
  const ua = amount(a.u), ub = amount(b.u), n = a.n / b.n;
  if (!ub) return { n, u: ua }; // $40 / 2 = $20
  if (ua === ub) return plain(n); // $40 / $20 = 2, 4 hours / 2 hours = 2
  return { n, u: ua === "cur" ? "cur" : "" }; // $40 / 2 hours = $20 (an hourly rate)
}

// ── Refs ─────────────────────────────────────────────────────────────────────────────────────────────
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

// "A1","B3" → [["A1","B1"],["A2","B2"],["A3","B3"]] (row-major, either corner order).
function rangeRefs(a: string, b: string): string[][] {
  const pa = parseRef(a), pb = parseRef(b);
  if (!pa || !pb) return [];
  const rows: string[][] = [];
  for (let r = Math.min(pa.row, pb.row); r <= Math.max(pa.row, pb.row); r++) {
    const row: string[] = [];
    for (let c = Math.min(pa.col, pb.col); c <= Math.max(pa.col, pb.col); c++) row.push(refName(c, r));
    rows.push(row);
  }
  return rows;
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────────────
// A formula value: number (with unit), text, logical, error or blank. Ranges are 2-D arrays of these.
type V = { t: "n"; n: number; u: Unit } | { t: "s"; s: string } | { t: "b"; b: boolean } | { t: "e"; e: string } | { t: "z" };
type Arr = { t: "a"; rows: V[][] };
type X = V | Arr;

class XlError extends Error {} // message = an Excel error code, becomes a value
class ParseError extends Error {}
class CycleError extends Error {}

const BLANK: V = { t: "z" };
const N = (n: number, u: Unit = ""): V => ({ t: "n", n, u });
const S = (s: string): V => ({ t: "s", s });
const B = (b: boolean): V => ({ t: "b", b });
const E = (e: string): V => ({ t: "e", e });
const fail = (code: string): never => { throw new XlError(code); };
const res = (n: number, u: Unit = ""): V => (Number.isFinite(n) ? N(n, u) : fail("#NUM!"));

const scalar = (x: X): V => (x.t === "a" ? (x.rows[0]?.[0] ?? BLANK) : x); // an array used as one value → its first cell
const toArr = (x: X): Arr => (x.t === "a" ? x : { t: "a", rows: [[x]] });
const flat = (x: X): V[] => (x.t === "a" ? x.rows.flat() : [x]);
const width = (m: Arr) => m.rows[0]?.length ?? 0;

function toNumV(x: X): Val {
  const v = scalar(x);
  switch (v.t) {
    case "n": return { n: v.n, u: v.u };
    case "b": return plain(v.b ? 1 : 0);
    case "z": return plain(0);
    case "e": return fail(v.e);
    case "s": return (v.s.trim() === "" ? null : parseLiteral(v.s)) ?? fail("#VALUE!");
  }
}
const num = (x: X) => toNumV(x).n;
function str(x: X): string {
  const v = scalar(x);
  switch (v.t) {
    case "s": return v.s;
    case "n": return formatValue(v);
    case "b": return v.b ? "TRUE" : "FALSE";
    case "z": return "";
    case "e": return fail(v.e);
  }
}
function bool(x: X): boolean {
  const v = scalar(x);
  switch (v.t) {
    case "b": return v.b;
    case "n": return v.n !== 0;
    case "z": return false;
    case "e": return fail(v.e);
    case "s": {
      const u = v.s.trim().toUpperCase();
      return u === "TRUE" ? true : u === "FALSE" ? false : fail("#VALUE!");
    }
  }
}

// Excel ordering: numbers < text < logicals; text compares case-insensitively; a blank acts as 0 / "" / FALSE.
function compare(a: V, b: V): number {
  if (a.t === "e") fail(a.e);
  if (b.t === "e") fail(b.e);
  const fill = (other: V): V => (other.t === "s" ? S("") : other.t === "b" ? B(false) : N(0));
  const x = a.t === "z" ? fill(b) : a, y = b.t === "z" ? fill(a) : b;
  const rank = (v: V) => (v.t === "n" ? 0 : v.t === "s" ? 1 : 2);
  if (x.t !== y.t) return rank(x) - rank(y);
  if (x.t === "n" && y.t === "n") { const d = x.n - y.n; return Math.abs(d) < 1e-9 ? 0 : Math.sign(d); }
  if (x.t === "s" && y.t === "s") { const p = x.s.toLowerCase(), q = y.s.toLowerCase(); return p < q ? -1 : p > q ? 1 : 0; }
  return Number((x as { b: boolean }).b) - Number((y as { b: boolean }).b);
}
const cmpOp = (op: string, c: number) =>
  op === "=" ? c === 0 : op === "<>" ? c !== 0 : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;

// Excel wildcards: * any run, ? one char, ~ escapes the next one.
function wildcard(pattern: string, anchored = true): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "~" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${re}$` : re, "i");
}

// A SUMIF/COUNTIF criterion: 5, TRUE, ">5", "<>done", "app*", "" (blank cells), "<>" (non-blank).
function criteria(c: V): (v: V) => boolean {
  if (c.t === "e") return fail(c.e);
  const blank = (v: V) => v.t === "z" || (v.t === "s" && v.s === "");
  if (c.t === "z") return blank;
  if (c.t === "n") return (v) => (v.t === "n" && Math.abs(v.n - c.n) < 1e-9) || (v.t === "s" && parseLiteral(v.s)?.n === c.n);
  if (c.t === "b") return (v) => v.t === "b" && v.b === c.b;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c.s)!;
  const op = m[1] ?? "=", rhs = m[2];
  if (rhs === "") return op === "<>" ? (v) => !blank(v) : blank;
  const lit = parseLiteral(rhs);
  if (lit) return (v) => (v.t === "n" ? cmpOp(op, compare(v, N(lit.n))) : op === "<>");
  const up = rhs.toUpperCase();
  if (up === "TRUE" || up === "FALSE") return (v) => (v.t === "b" ? cmpOp(op, compare(v, B(up === "TRUE"))) : op === "<>");
  if (op === "=" || op === "<>") {
    const re = wildcard(rhs);
    return (v) => (v.t === "s" && re.test(v.s)) === (op === "=");
  }
  return (v) => v.t === "s" && cmpOp(op, compare(v, S(rhs)));
}

// ── Tokenizer + parser ───────────────────────────────────────────────────────────────────────────────
type Tok = { t: "num" | "cur" | "str" | "ref" | "range" | "var" | "func" | "name" | "op" | "lp" | "rp" | "comma"; v: string };
const REF_AT = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?(?![A-Za-z0-9_.(])/;
const COLS_AT = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})(?![A-Za-z0-9_.(])/;

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i], rest = s.slice(i);
    let m: RegExpExecArray | null;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') { // "text", with "" as an escaped quote
      let j = i + 1, out = "";
      for (;;) {
        if (j >= s.length) throw new ParseError("unterminated string");
        if (s[j] === '"') { if (s[j + 1] === '"') { out += '"'; j += 2; continue; } break; }
        out += s[j++];
      }
      toks.push({ t: "str", v: out }); i = j + 1; continue;
    }
    if (c === "$" && /[0-9.]/.test(s[i + 1] ?? "")) { // $20 — a money literal (var names can't start with a digit)
      m = /^\$(\d+\.?\d*|\.\d+)/.exec(rest)!;
      toks.push({ t: "cur", v: m[1] }); i += m[0].length; continue;
    }
    // Cell refs and ranges: A1, a1, A1:B3, $A$1, A$1. A "$" ref must be upper-case ($A1), so "$cost" stays a variable.
    if ((c === "$" ? /^\$[A-Z]{1,3}\$?\d/.test(rest) : /[A-Za-z]/.test(c)) && (m = REF_AT.exec(rest))) {
      const a = (m[1] + m[2]).toUpperCase();
      toks.push(m[3] ? { t: "range", v: `${a}:${(m[3] + m[4]).toUpperCase()}` } : { t: "ref", v: a });
      i += m[0].length; continue;
    }
    if ((c === "$" ? /^\$[A-Z]{1,3}:/.test(rest) : /[A-Za-z]/.test(c)) && (m = COLS_AT.exec(rest))) { // A:A, B:D
      toks.push({ t: "range", v: `${m[1].toUpperCase()}1:${m[2].toUpperCase()}${SHEET_MAX_ROWS}` });
      i += m[0].length; continue;
    }
    if (c === "$") { // $name — a board-global variable reference (case-sensitive; name kept verbatim)
      m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      if (!m) throw new ParseError("expected variable name after $");
      toks.push({ t: "var", v: m[1] }); i += m[0].length; continue;
    }
    if (/[0-9.]/.test(c)) {
      m = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(rest);
      if (!m) throw new ParseError("bad number");
      toks.push({ t: "num", v: m[0] }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest)!;
      i += m[0].length;
      const after = /^\s*\(/.test(s.slice(i));
      toks.push({ t: after ? "func" : "name", v: m[0].toUpperCase() }); continue;
    }
    if ((m = /^(<>|<=|>=|[-+*/^&=<>%])/.exec(rest))) { toks.push({ t: "op", v: m[1] }); i += m[1].length; continue; }
    if (c === "(") { toks.push({ t: "lp", v: c }); i++; continue; }
    if (c === ")") { toks.push({ t: "rp", v: c }); i++; continue; }
    if (c === ",") { toks.push({ t: "comma", v: c }); i++; continue; }
    throw new ParseError("unexpected char: " + c);
  }
  return toks;
}

type Node =
  | { k: "lit"; v: V } | { k: "omit" } | { k: "ref"; ref: string } | { k: "range"; a: string; b: string }
  | { k: "var"; name: string } | { k: "un"; op: string; x: Node } | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

// Excel precedence, loosest first: comparisons, &, + −, * /, ^, unary −, postfix %.
function parse(toks: Tok[]): Node {
  let p = 0;
  const peek = () => toks[p];
  const eat = () => toks[p++];
  const isOp = (ops: string[]) => peek()?.t === "op" && ops.includes(peek().v);
  const level = (next: () => Node, ops: string[]) => (): Node => {
    let a = next();
    while (isOp(ops)) { const op = eat().v; a = { k: "bin", op, a, b: next() }; }
    return a;
  };
  const primary = (): Node => {
    const t = eat();
    if (!t) throw new ParseError("unexpected end");
    switch (t.t) {
      case "num": case "cur": {
        const n = parseFloat(t.v);
        if (isNaN(n)) throw new ParseError("bad number");
        return { k: "lit", v: N(n, t.t === "cur" ? "cur" : "") };
      }
      case "str": return { k: "lit", v: S(t.v) };
      case "ref": return { k: "ref", ref: t.v };
      case "range": { const [a, b] = t.v.split(":"); return { k: "range", a, b }; }
      case "var": return { k: "var", name: t.v };
      case "name": return { k: "lit", v: t.v === "TRUE" ? B(true) : t.v === "FALSE" ? B(false) : E("#NAME?") };
      case "lp": { const x = cmp(); if (eat()?.t !== "rp") throw new ParseError("missing )"); return x; }
      case "func": {
        eat(); // (
        const args: Node[] = [];
        if (peek()?.t === "rp") { eat(); return { k: "call", name: t.v, args }; }
        for (;;) {
          args.push(peek()?.t === "comma" || peek()?.t === "rp" ? { k: "omit" } : cmp());
          const sep = eat();
          if (sep?.t === "rp") break;
          if (sep?.t !== "comma") throw new ParseError("expected , or )");
        }
        return { k: "call", name: t.v, args };
      }
    }
    throw new ParseError("unexpected token: " + t.v);
  };
  const postfix = (): Node => { let x = primary(); while (isOp(["%"])) { eat(); x = { k: "un", op: "%", x }; } return x; };
  const unary = (): Node => (isOp(["-", "+"]) ? { k: "un", op: eat().v, x: unary() } : postfix());
  const pow = level(unary, ["^"]);
  const mul = level(pow, ["*", "/"]);
  const add = level(mul, ["+", "-"]);
  const cat = level(add, ["&"]);
  const cmp = level(cat, ["=", "<>", "<", ">", "<=", ">="]);
  const root = cmp();
  if (p !== toks.length) throw new ParseError("trailing tokens");
  return root;
}

// ── Evaluator ────────────────────────────────────────────────────────────────────────────────────────
type Ctx = { resolve: (ref: string) => V; vars: VarMap; units: VarUnits };

const safe = (f: () => V): V => {
  try { return f(); } catch (e) { if (e instanceof XlError) return E(e.message); throw e; }
};
function map1(x: X, f: (v: V) => V): X {
  return x.t === "a" ? { t: "a", rows: x.rows.map((r) => r.map((v) => safe(() => f(v)))) } : safe(() => f(x));
}
// Element-wise over arrays, broadcasting a single value / row / column like Excel.
function map2(a: X, b: X, f: (x: V, y: V) => V): X {
  if (a.t !== "a" && b.t !== "a") return safe(() => f(a, b));
  const A = toArr(a), Bm = toArr(b);
  const at = (m: Arr, r: number, c: number): V => m.rows[m.rows.length === 1 ? 0 : r]?.[width(m) === 1 ? 0 : c] ?? E("#N/A");
  const rows = Math.max(A.rows.length, Bm.rows.length), cols = Math.max(width(A), width(Bm));
  return { t: "a", rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => safe(() => f(at(A, r, c), at(Bm, r, c))))) };
}

function binop(op: string, a: V, b: V): V {
  if (a.t === "e") return a;
  if (b.t === "e") return b;
  switch (op) {
    case "+": case "-": { const r = addVals(toNumV(a), toNumV(b), op === "+" ? 1 : -1); return res(r.n, r.u); }
    case "*": { const r = mulVals(toNumV(a), toNumV(b)); return res(r.n, r.u); }
    case "/": { const y = toNumV(b); if (y.n === 0) fail("#DIV/0!"); const r = divVals(toNumV(a), y); return res(r.n, r.u); }
    case "^": return res(Math.pow(num(a), num(b)));
    case "&": return S(str(a) + str(b));
    default: return B(cmpOp(op, compare(a, b)));
  }
}

const varValues = (ctx: Ctx, name: string): V[] => (ctx.vars[name] ?? []).map((n) => N(n, ctx.units[name] ?? ""));

function ev(node: Node, ctx: Ctx): X {
  try { return evRaw(node, ctx); } catch (e) { if (e instanceof XlError) return E(e.message); throw e; }
}
function evRaw(node: Node, ctx: Ctx): X {
  switch (node.k) {
    case "lit": return node.v;
    case "omit": return BLANK;
    case "ref": return ctx.resolve(node.ref);
    case "range": {
      const rows = rangeRefs(node.a, node.b);
      return rows.length ? { t: "a", rows: rows.map((r) => r.map(ctx.resolve)) } : E("#REF!");
    }
    case "var": { // bare $name = SUM of its values, in the variable's unit
      const vs = ctx.vars[node.name] ?? [], u = ctx.units[node.name] ?? "";
      return N(vs.reduce((s, n) => s + n, 0), vs.length > 1 ? amount(u) : u);
    }
    case "un": return map1(ev(node.x, ctx), (v) => {
      const a = toNumV(v);
      return node.op === "%" ? N(a.n / 100, a.u) : N(node.op === "-" ? -a.n : a.n, a.u);
    });
    case "bin": return map2(ev(node.a, ctx), ev(node.b, ctx), (a, b) => binop(node.op, a, b));
    case "call": {
      const f = FN[node.name];
      return f ? f(mkArgs(node.args, ctx)) : E("#NAME?");
    }
  }
}

// Lazily-evaluated function arguments (so IF only evaluates the branch it takes).
type Args = { n: number; x(i: number): X; node(i: number): Node; has(i: number): boolean };
function mkArgs(nodes: Node[], ctx: Ctx): Args {
  const memo = new Map<number, X>();
  return {
    n: nodes.length,
    node: (i) => nodes[i] ?? { k: "omit" },
    has: (i) => i < nodes.length && nodes[i].k !== "omit",
    x(i) {
      if (i >= nodes.length) return BLANK;
      let v = memo.get(i);
      if (v === undefined) {
        const nd = nodes[i];
        v = nd.k === "var" ? { t: "a", rows: [varValues(ctx, nd.name)] } : ev(nd, ctx); // $name in a function = ALL its values
        memo.set(i, v);
      }
      return v;
    },
  };
}

// ── Argument helpers ─────────────────────────────────────────────────────────────────────────────────
const sc = (a: Args, i: number) => scalar(a.x(i));
const nv = (a: Args, i: number, dflt?: number): number => (a.has(i) ? num(a.x(i)) : dflt ?? fail("#VALUE!"));
const sv = (a: Args, i: number, dflt?: string): string => (a.has(i) ? str(a.x(i)) : dflt ?? fail("#VALUE!"));
const bv = (a: Args, i: number, dflt?: boolean): boolean => (a.has(i) ? bool(a.x(i)) : dflt ?? fail("#VALUE!"));
const unitOf = (vs: Val[]): Unit => vs.find((v) => v.u)?.u ?? "";
const fixFloat = (x: number) => Number(x.toPrecision(15)); // 2.675*100 = 267.49999… → 267.5, so ROUND agrees with Excel

// Numbers for SUM/AVERAGE/MAX…: inside a range (or a single cell ref) only real numbers count and text,
// TRUE/FALSE and blanks are skipped; a typed-in argument is coerced ("5" → 5, TRUE → 1). Errors propagate.
function numsOf(a: Args, from = 0, to = a.n): Val[] {
  const out: Val[] = [];
  for (let i = from; i < to; i++) {
    if (!a.has(i)) continue;
    const x = a.x(i);
    if (x.t === "a" || a.node(i).k === "ref") {
      for (const v of flat(x)) { if (v.t === "e") fail(v.e); if (v.t === "n") out.push({ n: v.n, u: v.u }); }
    } else out.push(toNumV(x));
  }
  return out;
}
const numbers = (a: Args, from = 0, to = a.n) => numsOf(a, from, to).map((v) => v.n);
// The "A" variants (AVERAGEA, MAXA…): text in a range counts as 0, TRUE/FALSE as 1/0.
function numsA(a: Args): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.n; i++) {
    if (!a.has(i)) continue;
    const x = a.x(i);
    if (x.t !== "a" && a.node(i).k !== "ref") { out.push(num(x)); continue; }
    for (const v of flat(x)) {
      if (v.t === "e") fail(v.e);
      if (v.t === "n") out.push(v.n); else if (v.t === "b") out.push(+v.b); else if (v.t === "s") out.push(0);
    }
  }
  return out;
}
// TRUE/FALSE values for AND/OR/XOR (text and blanks inside ranges are skipped).
function logicals(a: Args): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < a.n; i++) {
    if (!a.has(i)) continue;
    const x = a.x(i);
    if (x.t !== "a" && a.node(i).k !== "ref") { out.push(bool(x)); continue; }
    for (const v of flat(x)) {
      if (v.t === "e") fail(v.e);
      if (v.t === "b") out.push(v.b); else if (v.t === "n") out.push(v.n !== 0);
    }
  }
  return out.length ? out : fail("#VALUE!");
}
// Paired (range, criterion) arguments for the *IFS functions, starting at `from`.
function condSets(a: Args, from: number, len: number): ((i: number) => boolean)[] {
  const sets: ((i: number) => boolean)[] = [];
  for (let i = from; i + 1 < a.n; i += 2) {
    const r = flat(a.x(i)), t = criteria(sc(a, i + 1));
    if (r.length !== len) fail("#VALUE!");
    sets.push((k) => t(r[k]));
  }
  return sets;
}
function ifsPick(a: Args, valueArg: number, from: number): Val[] {
  const vals = flat(a.x(valueArg)), sets = condSets(a, from, vals.length), out: Val[] = [];
  vals.forEach((v, k) => { if (v.t === "n" && sets.every((t) => t(k))) out.push({ n: v.n, u: v.u }); });
  return out;
}

function roundTo(x: number, d: number, mode: "round" | "up" | "down"): number {
  const f = Math.pow(10, Math.trunc(d)), y = fixFloat(Math.abs(x) * f);
  const r = mode === "round" ? Math.round(y) : mode === "up" ? Math.ceil(y) : Math.floor(y);
  return (Math.sign(x) * r) / f;
}
function factorial(n: number): number {
  if (n < 0) fail("#NUM!");
  let r = 1;
  for (let i = 2; i <= Math.floor(n); i++) r *= i;
  return r;
}
const gcd2 = (x: number, y: number): number => (y ? gcd2(y, x % y) : x);
const sorted = (xs: number[]) => [...xs].sort((p, q) => p - q);
function percentile(xs: number[], k: number): number {
  if (!xs.length || k < 0 || k > 1) fail("#NUM!");
  const s = sorted(xs), pos = k * (s.length - 1), lo = Math.floor(pos);
  return s[lo] + (pos - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]);
}
function variance(xs: number[], sample: boolean): number {
  if (xs.length < (sample ? 2 : 1)) fail("#DIV/0!");
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - (sample ? 1 : 0));
}

// Lookups. `exact` honours wildcards in a text target when `wild`; approximate assumes sorted data.
function matches(v: V, t: V, wild: boolean): boolean {
  if (v.t === "e") return false;
  if (t.t === "s" && wild && /[*?~]/.test(t.s)) return v.t === "s" && wildcard(t.s).test(v.s);
  if (v.t === "z" || t.t === "z") return v.t === t.t;
  return v.t === t.t && compare(v, t) === 0;
}
// mode 0 exact, 2 wildcard, -1 exact or next smaller, 1 exact or next larger; search −1 = last to first.
function xfind(list: V[], t: V, mode: number, search: number): number {
  if (t.t === "e") fail(t.e);
  const order = list.map((_, i) => i);
  if (search < 0) order.reverse();
  if (mode === 0 || mode === 2) return order.find((i) => matches(list[i], t, mode === 2)) ?? -1;
  let best = -1;
  for (const i of order) {
    const v = list[i];
    if (v.t !== t.t || v.t === "e") continue;
    const c = compare(v, t);
    if (c === 0) return i;
    if ((mode < 0 ? c < 0 : c > 0) && (best < 0 || (mode < 0 ? compare(v, list[best]) > 0 : compare(v, list[best]) < 0))) best = i;
  }
  return best;
}
// MATCH/VLOOKUP approximate: data sorted ascending (dir 1, largest ≤ target) or descending (dir −1, smallest ≥).
function sortedFind(list: V[], t: V, dir: 1 | -1): number {
  if (t.t === "e") fail(t.e);
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v.t !== t.t) continue;
    const c = compare(v, t);
    if (dir > 0 ? c <= 0 : c >= 0) best = i; else break;
  }
  return best;
}

// Dates/times from any number: a date's fraction, a time/duration's hours, or a plain Excel serial.
const serialOf = (x: X): number => { const v = toNumV(x); return v.u === "time" || v.u === "dur" ? v.n / 24 : v.n; };
const secondsOfDay = (x: X): number => {
  const v = toNumV(x), h = v.u === "time" || v.u === "dur" ? v.n : (v.n - Math.floor(v.n)) * 24;
  return Math.round(wrap24(h) * 3600) % 86400;
};
const dateV = (serial: number): V => res(serial, "date");
function addMonths(serial: number, months: number, endOfMonth: boolean): number {
  const { y, m, d } = ymd(serial), last = ymd(serialFromYMD(y, m + months + 1, 0)).d;
  return serialFromYMD(y, m + months, endOfMonth ? last : Math.min(d, last));
}
const holidaySet = (a: Args, i: number) => new Set(a.has(i) ? flat(a.x(i)).filter((v) => v.t === "n").map((v) => Math.floor((v as { n: number }).n)) : []);
const isWorkday = (serial: number, hol: Set<number>) => { const wd = ymd(serial).wd; return wd !== 0 && wd !== 6 && !hol.has(serial); };

// Money math (Excel's sign convention: money you pay out is negative).
const pow1 = (r: number, n: number) => Math.pow(1 + r, n);
const pmtF = (r: number, n: number, pv: number, fv: number, type: number) =>
  r === 0 ? -(pv + fv) / n : -(r * (fv + pv * pow1(r, n))) / ((1 + r * type) * (pow1(r, n) - 1));
const fvF = (r: number, n: number, pmt: number, pv: number, type: number) =>
  r === 0 ? -(pv + pmt * n) : -(pv * pow1(r, n) + (pmt * (1 + r * type) * (pow1(r, n) - 1)) / r);
const pvF = (r: number, n: number, pmt: number, fv: number, type: number) =>
  r === 0 ? -(fv + pmt * n) : -(fv + (pmt * (1 + r * type) * (pow1(r, n) - 1)) / r) / pow1(r, n);
function ipmtF(r: number, per: number, n: number, pv: number, fv: number, type: number): number {
  const pmt = pmtF(r, n, pv, fv, type);
  const i = per === 1 ? (type === 1 ? 0 : -pv) : type === 1 ? fvF(r, per - 2, pmt, pv, 1) - pmt : fvF(r, per - 1, pmt, pv, 0);
  return i * r;
}
function newton(f: (r: number) => number, guess: number): number {
  let r = guess;
  for (let k = 0; k < 100; k++) {
    const y = f(r), d = (f(r + 1e-7) - y) / 1e-7;
    if (!Number.isFinite(y) || !Number.isFinite(d) || d === 0) break;
    const next = r - y / d;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  return fail("#NUM!");
}
// A money result when any of the given arguments was money.
const curOf = (a: Args, idx: number[]): Unit => (idx.some((i) => a.has(i) && toNumV(a.x(i)).u === "cur") ? "cur" : "");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// TEXT(value, format).
// shortcut: covers the common Excel codes (0, #,##0.00, 0%, $ prefixes, ;-sections, and dates/times like
// mm/dd/yyyy, mmm d, dddd, h:mm AM/PM). Fractions, colours, [h] and conditions aren't handled; add them if asked.
function formatText(v: Val, fmt: string): string {
  if (/^general$/i.test(fmt)) return fmtNum(v.n);
  const bare = fmt.replace(/"[^"]*"|\\./g, "");
  if (/[yd]|h|s|am\/pm|a\/p/i.test(bare)) {
    const serial = v.u === "time" || v.u === "dur" ? v.n / 24 : v.n;
    const { y, m, d, wd } = ymd(serial), secs = Math.round((serial - Math.floor(serial)) * 86400) % 86400;
    const H = Math.floor(secs / 3600), Mi = Math.floor(secs / 60) % 60, Se = secs % 60;
    const ampm = /am\/pm|a\/p/i.test(bare), h12 = H % 12 || 12;
    const toks = fmt.match(/"[^"]*"|\\.|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|am\/pm|A\/P|a\/p|[\s\S]/g) ?? [];
    const isMin = (k: number) => // m/mm right after an hour or right before seconds means minutes
      toks.slice(0, k).reverse().find((t) => /^(h+|s+|y+|d+|m+)$/i.test(t))?.match(/^h/i) ||
      /^s/i.test(toks.slice(k + 1).find((t) => /^(h+|s+|y+|d+|m+)$/i.test(t)) ?? "");
    return toks.map((t, k) => {
      const two = (n: number) => String(n).padStart(2, "0");
      switch (t) {
        case "yyyy": return String(y);
        case "yy": return two(y % 100);
        case "mmmm": return MONTHS[m - 1];
        case "mmm": return MONTHS[m - 1].slice(0, 3);
        case "mm": return isMin(k) ? two(Mi) : two(m);
        case "m": return isMin(k) ? String(Mi) : String(m);
        case "dddd": return DAYS[wd];
        case "ddd": return DAYS[wd].slice(0, 3);
        case "dd": return two(d);
        case "d": return String(d);
        case "hh": return two(ampm ? h12 : H);
        case "h": return String(ampm ? h12 : H);
        case "ss": return two(Se);
        case "s": return String(Se);
        case "AM/PM": return H < 12 ? "AM" : "PM";
        case "am/pm": return H < 12 ? "am" : "pm";
        case "A/P": return H < 12 ? "A" : "P";
        case "a/p": return H < 12 ? "a" : "p";
      }
      return t[0] === '"' ? t.slice(1, -1) : t[0] === "\\" ? t.slice(1) : t;
    }).join("");
  }
  const secs = fmt.split(";");
  let n = v.n, f = secs[0], neg = n < 0;
  if (n < 0 && secs[1] !== undefined) { f = secs[1]; neg = false; n = -n; }
  else if (n === 0 && secs[2] !== undefined) f = secs[2];
  const lit = (s: string) => s.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1");
  const m = /[#0][#0,]*(\.[#0]*)?|\.[#0]+/.exec(f);
  if (!m) return lit(f);
  if (f.includes("%")) n *= 100;
  const dec = (m[0].split(".")[1] ?? ""), intPart = m[0].split(".")[0];
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: (dec.match(/0/g) ?? []).length, maximumFractionDigits: dec.length,
    useGrouping: intPart.includes(","), minimumIntegerDigits: Math.max(1, (intPart.match(/0/g) ?? []).length),
  });
  return (neg && Math.abs(n) >= 0.5 * 10 ** -dec.length ? "-" : "") + lit(f.slice(0, m.index)) + body + lit(f.slice(m.index + m[0].length));
}

// ── Functions ────────────────────────────────────────────────────────────────────────────────────────
const FN: Record<string, (a: Args) => X> = {};
const def = (names: string, f: (a: Args) => X) => { for (const n of names.split(" ")) FN[n] = f; };
const math1 = (names: string, f: (x: number) => number) => def(names, (a) => res(f(nv(a, 0))));
const keepUnit = (names: string, f: (x: number, a: Args) => number) =>
  def(names, (a) => { const v = toNumV(a.x(0)); return res(f(v.n, a), v.u); });
const isType = (names: string, f: (v: V) => boolean) => def(names, (a) => B(f(sc(a, 0))));

// Logical
def("IF", (a) => (bool(a.x(0)) ? (a.has(1) ? a.x(1) : a.n > 1 ? N(0) : B(true)) : a.n > 2 ? (a.has(2) ? a.x(2) : N(0)) : B(false)));
def("IFS", (a) => { for (let i = 0; i + 1 < a.n; i += 2) if (bool(a.x(i))) return a.x(i + 1); return E("#N/A"); });
def("AND", (a) => B(logicals(a).every(Boolean)));
def("OR", (a) => B(logicals(a).some(Boolean)));
def("XOR", (a) => B(logicals(a).filter(Boolean).length % 2 === 1));
def("NOT", (a) => B(!bool(a.x(0))));
def("TRUE", () => B(true));
def("FALSE", () => B(false));
def("IFERROR", (a) => (sc(a, 0).t === "e" ? a.x(1) : a.x(0)));
def("IFNA", (a) => { const v = sc(a, 0); return v.t === "e" && v.e === "#N/A" ? a.x(1) : a.x(0); });
def("SWITCH", (a) => {
  const v = sc(a, 0);
  if (v.t === "e") return v;
  let i = 1;
  for (; i + 1 < a.n; i += 2) if (compare(v, sc(a, i)) === 0) return a.x(i + 1);
  return i < a.n ? a.x(i) : E("#N/A");
});
def("CHOOSE", (a) => { const i = Math.trunc(nv(a, 0)); return i >= 1 && i < a.n ? a.x(i) : E("#VALUE!"); });

// Information
isType("ISBLANK", (v) => v.t === "z");
isType("ISNUMBER", (v) => v.t === "n");
isType("ISTEXT", (v) => v.t === "s");
isType("ISNONTEXT", (v) => v.t !== "s");
isType("ISLOGICAL", (v) => v.t === "b");
isType("ISERROR", (v) => v.t === "e");
isType("ISERR", (v) => v.t === "e" && v.e !== "#N/A");
isType("ISNA", (v) => v.t === "e" && v.e === "#N/A");
def("ISEVEN", (a) => B(Math.trunc(nv(a, 0)) % 2 === 0));
def("ISODD", (a) => B(Math.abs(Math.trunc(nv(a, 0))) % 2 === 1));
def("N", (a) => { const v = sc(a, 0); return v.t === "n" || v.t === "e" ? v : v.t === "b" ? N(+v.b) : N(0); });
def("T", (a) => { const v = sc(a, 0); return v.t === "s" || v.t === "e" ? v : S(""); });
def("NA", () => E("#N/A"));
def("TYPE", (a) => { const x = a.x(0); return N(x.t === "a" ? 64 : { n: 1, z: 1, s: 2, b: 4, e: 16 }[x.t]); });
def("ERROR.TYPE", (a) => {
  const v = sc(a, 0), i = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"].indexOf(v.t === "e" ? v.e : "");
  return i < 0 ? E("#N/A") : N(i + 1);
});

// Math
def("SUM", (a) => { const v = numsOf(a); return res(v.reduce((s, x) => s + x.n, 0), amount(unitOf(v))); });
def("PRODUCT", (a) => { const v = numsOf(a), p = v.reduce(mulVals, plain(1)); return v.length ? res(p.n, p.u) : N(0); });
def("SUMSQ", (a) => res(numbers(a).reduce((s, x) => s + x * x, 0)));
def("SUMPRODUCT", (a) => {
  const ms = Array.from({ length: a.n }, (_, i) => toArr(a.x(i)));
  const R = ms[0]?.rows.length ?? 0, C = ms[0] ? width(ms[0]) : 0;
  if (ms.some((m) => m.rows.length !== R || width(m) !== C)) fail("#VALUE!");
  let s = 0, u: Unit = "";
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    let p = 1;
    for (const m of ms) {
      const v = m.rows[r][c];
      if (v.t === "e") fail(v.e);
      if (v.t === "n" && v.u === "cur") u = "cur";
      p *= v.t === "n" ? v.n : 0; // text and TRUE/FALSE count as 0, like Excel
    }
    s += p;
  }
  return res(s, u);
});
keepUnit("ABS", (x) => Math.abs(x));
keepUnit("ROUND", (x, a) => roundTo(x, nv(a, 1, 0), "round"));
keepUnit("ROUNDUP", (x, a) => roundTo(x, nv(a, 1, 0), "up"));
keepUnit("ROUNDDOWN", (x, a) => roundTo(x, nv(a, 1, 0), "down"));
keepUnit("TRUNC", (x, a) => roundTo(x, nv(a, 1, 0), "down"));
keepUnit("INT", (x) => Math.floor(fixFloat(x)));
keepUnit("MROUND", (x, a) => { const m = nv(a, 1); if (m === 0) return 0; if (x * m < 0) fail("#NUM!"); return Math.round(fixFloat(x / m)) * m; });
keepUnit("CEILING", (x, a) => { const s = nv(a, 1, 1); if (s === 0) return 0; if (x > 0 && s < 0) fail("#NUM!"); return Math.ceil(fixFloat(x / s)) * s; });
keepUnit("FLOOR", (x, a) => { const s = nv(a, 1, 1); if (s === 0) fail("#DIV/0!"); if (x > 0 && s < 0) fail("#NUM!"); return Math.floor(fixFloat(x / s)) * s; });
keepUnit("CEILING.MATH CEILING.PRECISE ISO.CEILING", (x, a) => {
  const s = Math.abs(nv(a, 1, 1)) || 1;
  return x < 0 && nv(a, 2, 0) ? -Math.ceil(fixFloat(-x / s)) * s : Math.ceil(fixFloat(x / s)) * s;
});
keepUnit("FLOOR.MATH FLOOR.PRECISE", (x, a) => {
  const s = Math.abs(nv(a, 1, 1)) || 1;
  return x < 0 && nv(a, 2, 0) ? -Math.floor(fixFloat(-x / s)) * s : Math.floor(fixFloat(x / s)) * s;
});
keepUnit("EVEN", (x) => Math.sign(x) * Math.ceil(fixFloat(Math.abs(x) / 2)) * 2);
keepUnit("ODD", (x) => { let r = Math.ceil(fixFloat(Math.abs(x))); if (r % 2 === 0) r++; return (x < 0 ? -1 : 1) * r; });
def("MOD", (a) => { const x = toNumV(a.x(0)), d = nv(a, 1); if (d === 0) fail("#DIV/0!"); return res(x.n - d * Math.floor(fixFloat(x.n / d)), x.u); });
def("QUOTIENT", (a) => { const d = nv(a, 1); if (d === 0) fail("#DIV/0!"); return res(Math.trunc(nv(a, 0) / d)); });
math1("SIGN", Math.sign);
def("POWER", (a) => res(Math.pow(nv(a, 0), nv(a, 1))));
def("SQRT", (a) => { const x = nv(a, 0); return x < 0 ? E("#NUM!") : N(Math.sqrt(x)); });
def("SQRTPI", (a) => { const x = nv(a, 0); return x < 0 ? E("#NUM!") : N(Math.sqrt(x * Math.PI)); });
math1("EXP", Math.exp);
def("LN", (a) => { const x = nv(a, 0); return x <= 0 ? E("#NUM!") : N(Math.log(x)); });
def("LOG10", (a) => { const x = nv(a, 0); return x <= 0 ? E("#NUM!") : N(Math.log10(x)); });
def("LOG", (a) => {
  const x = nv(a, 0), b = nv(a, 1, 10);
  return x <= 0 || b <= 0 ? E("#NUM!") : b === 1 ? E("#DIV/0!") : res(Math.log(x) / Math.log(b));
});
def("PI", () => N(Math.PI));
def("RAND", () => N(Math.random()));
def("RANDBETWEEN", (a) => {
  const lo = Math.ceil(nv(a, 0)), hi = Math.floor(nv(a, 1));
  return lo > hi ? E("#NUM!") : N(lo + Math.floor(Math.random() * (hi - lo + 1)));
});
def("FACT", (a) => res(factorial(nv(a, 0))));
def("FACTDOUBLE", (a) => { const n = Math.floor(nv(a, 0)); if (n < -1) fail("#NUM!"); let r = 1; for (let i = n; i > 1; i -= 2) r *= i; return res(r); });
def("COMBIN", (a) => {
  const n = Math.trunc(nv(a, 0)), k = Math.trunc(nv(a, 1));
  if (k < 0 || n < k) fail("#NUM!");
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return res(Math.round(r));
});
def("PERMUT", (a) => {
  const n = Math.trunc(nv(a, 0)), k = Math.trunc(nv(a, 1));
  if (k < 0 || n < k) fail("#NUM!");
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return res(r);
});
def("GCD", (a) => { const xs = numbers(a).map(Math.trunc); if (xs.some((x) => x < 0)) fail("#NUM!"); return N(xs.reduce(gcd2, 0)); });
def("LCM", (a) => {
  const xs = numbers(a).map(Math.trunc);
  if (xs.some((x) => x < 0)) fail("#NUM!");
  return res(xs.reduce((l, x) => (l === 0 || x === 0 ? 0 : (l * x) / gcd2(l, x)), 1));
});
math1("DEGREES", (x) => (x * 180) / Math.PI);
math1("RADIANS", (x) => (x * Math.PI) / 180);
math1("SIN", Math.sin);
math1("COS", Math.cos);
math1("TAN", Math.tan);
math1("ASIN", (x) => (Math.abs(x) > 1 ? NaN : Math.asin(x)));
math1("ACOS", (x) => (Math.abs(x) > 1 ? NaN : Math.acos(x)));
math1("ATAN", Math.atan);
def("ATAN2", (a) => { const x = nv(a, 0), y = nv(a, 1); return x === 0 && y === 0 ? E("#DIV/0!") : N(Math.atan2(y, x)); });
math1("SINH", Math.sinh);
math1("COSH", Math.cosh);
math1("TANH", Math.tanh);
math1("ASINH", Math.asinh);
math1("ACOSH", (x) => (x < 1 ? NaN : Math.acosh(x)));
math1("ATANH", (x) => (Math.abs(x) >= 1 ? NaN : Math.atanh(x)));

// Statistics
def("AVERAGE AVG", (a) => { const v = numsOf(a); if (!v.length) fail("#DIV/0!"); return res(v.reduce((s, x) => s + x.n, 0) / v.length, unitOf(v)); });
def("AVERAGEA", (a) => { const xs = numsA(a); if (!xs.length) fail("#DIV/0!"); return res(xs.reduce((s, x) => s + x, 0) / xs.length); });
def("MIN", (a) => { const v = numsOf(a); return v.length ? res(Math.min(...v.map((x) => x.n)), unitOf(v)) : N(0); });
def("MAX", (a) => { const v = numsOf(a); return v.length ? res(Math.max(...v.map((x) => x.n)), unitOf(v)) : N(0); });
def("MINA", (a) => { const xs = numsA(a); return N(xs.length ? Math.min(...xs) : 0); });
def("MAXA", (a) => { const xs = numsA(a); return N(xs.length ? Math.max(...xs) : 0); });
def("COUNT", (a) => {
  let n = 0;
  for (let i = 0; i < a.n; i++) {
    if (!a.has(i)) continue;
    const x = a.x(i);
    if (x.t === "a" || a.node(i).k === "ref") n += flat(x).filter((v) => v.t === "n").length;
    else if (x.t === "n" || x.t === "b" || (x.t === "s" && parseLiteral(x.s))) n++;
  }
  return N(n);
});
def("COUNTA", (a) => {
  let n = 0;
  for (let i = 0; i < a.n; i++) if (a.has(i)) n += flat(a.x(i)).filter((v) => v.t !== "z").length;
  return N(n);
});
def("COUNTBLANK", (a) => N(flat(a.x(0)).filter((v) => v.t === "z" || (v.t === "s" && v.s === "")).length));
def("MEDIAN", (a) => { const v = numsOf(a); if (!v.length) fail("#NUM!"); return res(percentile(v.map((x) => x.n), 0.5), unitOf(v)); });
def("MODE MODE.SNGL", (a) => {
  const xs = numbers(a), counts = new Map<number, number>();
  let best = NaN, top = 1;
  for (const x of xs) { const c = (counts.get(x) ?? 0) + 1; counts.set(x, c); if (c > top) { top = c; best = x; } }
  return Number.isNaN(best) ? E("#N/A") : N(best);
});
def("LARGE", (a) => { const v = numsOf(a, 0, 1).sort((p, q) => q.n - p.n), k = Math.ceil(nv(a, 1)); return k < 1 || k > v.length ? E("#NUM!") : N(v[k - 1].n, v[k - 1].u); });
def("SMALL", (a) => { const v = numsOf(a, 0, 1).sort((p, q) => p.n - q.n), k = Math.ceil(nv(a, 1)); return k < 1 || k > v.length ? E("#NUM!") : N(v[k - 1].n, v[k - 1].u); });
def("RANK RANK.EQ", (a) => {
  const x = nv(a, 0), xs = numbers(a, 1, 2), asc = nv(a, 2, 0) !== 0;
  if (!xs.some((y) => Math.abs(y - x) < 1e-9)) return E("#N/A");
  return N(1 + xs.filter((y) => (asc ? y < x : y > x) && Math.abs(y - x) >= 1e-9).length);
});
def("PERCENTILE PERCENTILE.INC", (a) => res(percentile(numbers(a, 0, 1), nv(a, 1))));
def("QUARTILE QUARTILE.INC", (a) => { const q = Math.trunc(nv(a, 1)); return q < 0 || q > 4 ? E("#NUM!") : res(percentile(numbers(a, 0, 1), q / 4)); });
def("STDEV STDEV.S", (a) => res(Math.sqrt(variance(numbers(a), true))));
def("STDEVP STDEV.P", (a) => res(Math.sqrt(variance(numbers(a), false))));
def("VAR VAR.S", (a) => res(variance(numbers(a), true)));
def("VARP VAR.P", (a) => res(variance(numbers(a), false)));
def("AVEDEV", (a) => {
  const xs = numbers(a);
  if (!xs.length) fail("#NUM!");
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return res(xs.reduce((s, x) => s + Math.abs(x - m), 0) / xs.length);
});
def("GEOMEAN", (a) => { const xs = numbers(a); if (!xs.length || xs.some((x) => x <= 0)) fail("#NUM!"); return res(Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length)); });
def("HARMEAN", (a) => { const xs = numbers(a); if (!xs.length || xs.some((x) => x <= 0)) fail("#NUM!"); return res(xs.length / xs.reduce((s, x) => s + 1 / x, 0)); });
def("CORREL PEARSON", (a) => {
  const p = flat(a.x(0)), q = flat(a.x(1));
  if (p.length !== q.length) fail("#N/A");
  const xs: number[] = [], ys: number[] = [];
  p.forEach((v, i) => { const w = q[i]; if (v.t === "n" && w.t === "n") { xs.push(v.n); ys.push(w.n); } });
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  return sxx === 0 || syy === 0 ? E("#DIV/0!") : res(sxy / Math.sqrt(sxx * syy));
});

// Conditional totals
def("COUNTIF", (a) => { const t = criteria(sc(a, 1)); return N(flat(a.x(0)).filter(t).length); });
def("COUNTIFS", (a) => {
  const len = flat(a.x(0)).length, sets = condSets(a, 0, len);
  let n = 0;
  for (let k = 0; k < len; k++) if (sets.every((t) => t(k))) n++;
  return N(n);
});
def("SUMIF", (a) => {
  const r = flat(a.x(0)), t = criteria(sc(a, 1)), s = a.has(2) ? flat(a.x(2)) : r, picked: Val[] = [];
  r.forEach((v, k) => { const x = s[k]; if (t(v) && x?.t === "n") picked.push({ n: x.n, u: x.u }); });
  return res(picked.reduce((sum, x) => sum + x.n, 0), amount(unitOf(picked)));
});
def("SUMIFS", (a) => { const v = ifsPick(a, 0, 1); return res(v.reduce((s, x) => s + x.n, 0), amount(unitOf(v))); });
def("AVERAGEIF", (a) => {
  const r = flat(a.x(0)), t = criteria(sc(a, 1)), s = a.has(2) ? flat(a.x(2)) : r, picked: Val[] = [];
  r.forEach((v, k) => { const x = s[k]; if (t(v) && x?.t === "n") picked.push({ n: x.n, u: x.u }); });
  return picked.length ? res(picked.reduce((sum, x) => sum + x.n, 0) / picked.length, unitOf(picked)) : E("#DIV/0!");
});
def("AVERAGEIFS", (a) => { const v = ifsPick(a, 0, 1); return v.length ? res(v.reduce((s, x) => s + x.n, 0) / v.length, unitOf(v)) : E("#DIV/0!"); });
def("MAXIFS", (a) => { const v = ifsPick(a, 0, 1); return v.length ? res(Math.max(...v.map((x) => x.n)), unitOf(v)) : N(0); });
def("MINIFS", (a) => { const v = ifsPick(a, 0, 1); return v.length ? res(Math.min(...v.map((x) => x.n)), unitOf(v)) : N(0); });

// Text
def("CONCAT", (a) => S(Array.from({ length: a.n }, (_, i) => flat(a.x(i)).map(str).join("")).join("")));
def("CONCATENATE", (a) => S(Array.from({ length: a.n }, (_, i) => str(a.x(i))).join("")));
def("TEXTJOIN", (a) => {
  const d = sv(a, 0, ""), skip = bv(a, 1), parts: string[] = [];
  for (let i = 2; i < a.n; i++) for (const v of flat(a.x(i))) { const s = str(v); if (!(skip && s === "")) parts.push(s); }
  return S(parts.join(d));
});
def("LEFT", (a) => { const n = nv(a, 1, 1); return n < 0 ? E("#VALUE!") : S(sv(a, 0).slice(0, n)); });
def("RIGHT", (a) => { const s = sv(a, 0), n = nv(a, 1, 1); return n < 0 ? E("#VALUE!") : S(n === 0 ? "" : s.slice(-n)); });
def("MID", (a) => { const st = Math.trunc(nv(a, 1)), n = Math.trunc(nv(a, 2)); return st < 1 || n < 0 ? E("#VALUE!") : S(sv(a, 0).substr(st - 1, n)); });
def("LEN", (a) => N(sv(a, 0).length));
def("UPPER", (a) => S(sv(a, 0).toUpperCase()));
def("LOWER", (a) => S(sv(a, 0).toLowerCase()));
def("PROPER", (a) => S(sv(a, 0).toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())));
def("TRIM", (a) => S(sv(a, 0).trim().replace(/ {2,}/g, " ")));
def("CLEAN", (a) => S(sv(a, 0).replace(/[\x00-\x1f]/g, "")));
def("SUBSTITUTE", (a) => {
  const s = sv(a, 0), from = sv(a, 1), to = sv(a, 2);
  if (from === "") return S(s);
  if (!a.has(3)) return S(s.split(from).join(to));
  const nth = Math.trunc(nv(a, 3));
  if (nth < 1) fail("#VALUE!");
  let at = -1;
  for (let k = 0; k < nth; k++) { at = s.indexOf(from, at + 1); if (at < 0) return S(s); }
  return S(s.slice(0, at) + to + s.slice(at + from.length));
});
def("REPLACE", (a) => { const s = sv(a, 0), st = Math.trunc(nv(a, 1)), n = Math.trunc(nv(a, 2)); return st < 1 || n < 0 ? E("#VALUE!") : S(s.slice(0, st - 1) + sv(a, 3) + s.slice(st - 1 + n)); });
def("FIND", (a) => { const at = sv(a, 1).indexOf(sv(a, 0), nv(a, 2, 1) - 1); return at < 0 ? E("#VALUE!") : N(at + 1); });
def("SEARCH", (a) => {
  const within = sv(a, 1), start = nv(a, 2, 1) - 1, m = wildcard(sv(a, 0), false).exec(within.slice(start));
  return m ? N(start + m.index + 1) : E("#VALUE!");
});
def("REPT", (a) => { const n = Math.trunc(nv(a, 1)); return n < 0 ? E("#VALUE!") : S(sv(a, 0).repeat(n)); });
def("EXACT", (a) => B(sv(a, 0) === sv(a, 1)));
def("VALUE NUMBERVALUE", (a) => { const v = sc(a, 0); if (v.t === "n") return N(v.n); const p = parseLiteral(str(v)); return p ? N(p.n) : E("#VALUE!"); });
def("TEXT", (a) => S(formatText(toNumV(a.x(0)), sv(a, 1))));
def("FIXED", (a) => {
  const d = Math.trunc(nv(a, 1, 2)), x = roundTo(nv(a, 0), d, "round");
  return S(x.toLocaleString("en-US", { minimumFractionDigits: Math.max(0, d), maximumFractionDigits: Math.max(0, d), useGrouping: !bv(a, 2, false) }));
});
def("DOLLAR", (a) => {
  const d = Math.trunc(nv(a, 1, 2)), x = roundTo(nv(a, 0), d, "round");
  return S((x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: Math.max(0, d), maximumFractionDigits: Math.max(0, d) }));
});
def("CHAR", (a) => { const n = Math.trunc(nv(a, 0)); return n < 1 || n > 255 ? E("#VALUE!") : S(String.fromCharCode(n)); });
def("UNICHAR", (a) => { const n = Math.trunc(nv(a, 0)); return n < 1 || n > 0x10ffff ? E("#VALUE!") : S(String.fromCodePoint(n)); });
def("CODE UNICODE", (a) => { const s = sv(a, 0); return s === "" ? E("#VALUE!") : N(s.codePointAt(0)!); });
for (const [name, before] of [["TEXTBEFORE", true], ["TEXTAFTER", false]] as const) {
  def(name, (a) => {
    const s = sv(a, 0), d = sv(a, 1), n = Math.trunc(nv(a, 2, 1));
    if (d === "" || n === 0) fail("#VALUE!");
    const parts = s.split(d);
    if (Math.abs(n) >= parts.length) return E("#N/A");
    const cut = n > 0 ? n : parts.length + n;
    return S(before ? parts.slice(0, cut).join(d) : parts.slice(cut).join(d));
  });
}

// Lookup & reference
def("VLOOKUP", (a) => {
  const t = sc(a, 0), m = toArr(a.x(1)), col = Math.trunc(nv(a, 2));
  if (col < 1) fail("#VALUE!");
  if (col > width(m)) fail("#REF!");
  const keys = m.rows.map((r) => r[0]), i = bv(a, 3, true) ? sortedFind(keys, t, 1) : xfind(keys, t, 2, 1);
  return i < 0 ? E("#N/A") : m.rows[i][col - 1];
});
def("HLOOKUP", (a) => {
  const t = sc(a, 0), m = toArr(a.x(1)), row = Math.trunc(nv(a, 2));
  if (row < 1) fail("#VALUE!");
  if (row > m.rows.length) fail("#REF!");
  const keys = m.rows[0] ?? [], i = bv(a, 3, true) ? sortedFind(keys, t, 1) : xfind(keys, t, 2, 1);
  return i < 0 ? E("#N/A") : m.rows[row - 1][i];
});
def("LOOKUP", (a) => {
  const keys = flat(a.x(1)), out = a.has(2) ? flat(a.x(2)) : keys, i = sortedFind(keys, sc(a, 0), 1);
  return i < 0 || !out[i] ? E("#N/A") : out[i];
});
def("MATCH", (a) => {
  const list = flat(a.x(1)), t = sc(a, 0), type = nv(a, 2, 1);
  const i = type === 0 ? xfind(list, t, 2, 1) : sortedFind(list, t, type > 0 ? 1 : -1);
  return i < 0 ? E("#N/A") : N(i + 1);
});
def("XMATCH", (a) => { const i = xfind(flat(a.x(1)), sc(a, 0), nv(a, 2, 0), nv(a, 3, 1)); return i < 0 ? E("#N/A") : N(i + 1); });
def("XLOOKUP", (a) => {
  const L = toArr(a.x(1)), R = toArr(a.x(2)), vertical = L.rows.length > 1 || width(L) === 1;
  const i = xfind(flat(L), sc(a, 0), nv(a, 4, 0), nv(a, 5, 1));
  if (i < 0) return a.has(3) ? a.x(3) : E("#N/A");
  if (vertical) {
    const row = R.rows[i];
    if (!row) fail("#REF!");
    return row.length === 1 ? row[0] : { t: "a", rows: [row] };
  }
  const col = R.rows.map((r) => r[i]);
  if (col.some((v) => v === undefined)) fail("#REF!");
  return col.length === 1 ? col[0] : { t: "a", rows: col.map((v) => [v]) };
});
def("INDEX", (a) => {
  const m = toArr(a.x(0));
  let r = Math.trunc(nv(a, 1, 0)), c = Math.trunc(nv(a, 2, 0));
  if (!a.has(2) && m.rows.length === 1) { c = r; r = 1; } // INDEX(A1:E1, 3) picks the 3rd column
  if (r < 0 || c < 0 || r > m.rows.length || c > width(m)) fail("#REF!");
  if (r === 0 && c === 0) return m;
  if (r === 0) return { t: "a", rows: m.rows.map((row) => [row[c - 1]]) };
  if (c === 0) return width(m) === 1 ? m.rows[r - 1][0] : { t: "a", rows: [m.rows[r - 1]] };
  return m.rows[r - 1][c - 1];
});
def("ROWS", (a) => N(toArr(a.x(0)).rows.length));
def("COLUMNS", (a) => N(width(toArr(a.x(0)))));
def("ROW", (a) => { const nd = a.node(0), p = parseRef(nd.k === "ref" ? nd.ref : nd.k === "range" ? nd.a : ""); return p ? N(p.row + 1) : E("#VALUE!"); });
def("COLUMN", (a) => { const nd = a.node(0), p = parseRef(nd.k === "ref" ? nd.ref : nd.k === "range" ? nd.a : ""); return p ? N(p.col + 1) : E("#VALUE!"); });
def("TRANSPOSE", (a) => { const m = toArr(a.x(0)); return { t: "a", rows: Array.from({ length: width(m) }, (_, c) => m.rows.map((r) => r[c])) }; });

// Date & time
def("TODAY", () => dateV(Math.floor(nowSerial())));
def("NOW", () => dateV(nowSerial()));
def("DATE", (a) => { let y = Math.trunc(nv(a, 0)); if (y < 1900) y += 1900; return dateV(serialFromYMD(y, Math.trunc(nv(a, 1)), Math.trunc(nv(a, 2)))); });
def("TIME", (a) => res(wrap24(nv(a, 0) + nv(a, 1) / 60 + nv(a, 2) / 3600), "time"));
def("TIMEVALUE", (a) => {
  const p = parseLiteral(sv(a, 0));
  return p?.u === "time" ? N(p.n, "time") : p?.u === "date" ? N((p.n - Math.floor(p.n)) * 24, "time") : E("#VALUE!");
});
def("DATEVALUE", (a) => { const p = parseLiteral(sv(a, 0)); return p?.u === "date" ? dateV(Math.floor(p.n)) : E("#VALUE!"); });
def("HOUR", (a) => N(Math.floor(secondsOfDay(a.x(0)) / 3600)));
def("MINUTE", (a) => N(Math.floor(secondsOfDay(a.x(0)) / 60) % 60));
def("SECOND", (a) => N(secondsOfDay(a.x(0)) % 60));
def("YEAR", (a) => N(ymd(serialOf(a.x(0))).y));
def("MONTH", (a) => N(ymd(serialOf(a.x(0))).m));
def("DAY", (a) => N(ymd(serialOf(a.x(0))).d));
def("WEEKDAY", (a) => {
  const wd = ymd(serialOf(a.x(0))).wd, type = nv(a, 1, 1);
  return type === 1 ? N(wd + 1) : type === 2 ? N(((wd + 6) % 7) + 1) : type === 3 ? N((wd + 6) % 7) : E("#NUM!");
});
def("WEEKNUM", (a) => {
  const s = Math.floor(serialOf(a.x(0))), jan1 = serialFromYMD(ymd(s).y, 1, 1), wd = ymd(jan1).wd;
  const offset = nv(a, 1, 1) === 2 ? (wd + 6) % 7 : wd;
  return N(Math.floor((s - jan1 + offset) / 7) + 1);
});
def("EDATE", (a) => dateV(addMonths(serialOf(a.x(0)), Math.trunc(nv(a, 1)), false)));
def("EOMONTH", (a) => dateV(addMonths(serialOf(a.x(0)), Math.trunc(nv(a, 1)), true)));
def("DAYS", (a) => N(Math.floor(serialOf(a.x(0))) - Math.floor(serialOf(a.x(1)))));
def("DATEDIF", (a) => {
  const s0 = Math.floor(serialOf(a.x(0))), e0 = Math.floor(serialOf(a.x(1))), unit = sv(a, 2).toUpperCase();
  if (s0 > e0) fail("#NUM!");
  const s = ymd(s0), e = ymd(e0);
  let months = (e.y - s.y) * 12 + (e.m - s.m);
  if (e.d < s.d) months--;
  switch (unit) {
    case "D": return N(e0 - s0);
    case "M": return N(months);
    case "Y": return N(Math.floor(months / 12));
    case "YM": return N(months % 12);
    case "MD": return N(e.d >= s.d ? e.d - s.d : e0 - serialFromYMD(e.y, e.m - 1, s.d));
    case "YD": { let t = serialFromYMD(e.y, s.m, s.d); if (t > e0) t = serialFromYMD(e.y - 1, s.m, s.d); return N(e0 - t); }
  }
  return E("#NUM!");
});
def("NETWORKDAYS", (a) => {
  const s = Math.floor(serialOf(a.x(0))), e = Math.floor(serialOf(a.x(1))), hol = holidaySet(a, 2);
  let n = 0;
  for (let d = Math.min(s, e); d <= Math.max(s, e); d++) if (isWorkday(d, hol)) n++;
  return N(s <= e ? n : -n);
});
def("WORKDAY", (a) => {
  let d = Math.floor(serialOf(a.x(0)));
  const days = Math.trunc(nv(a, 1)), step = days < 0 ? -1 : 1, hol = holidaySet(a, 2);
  for (let left = Math.abs(days); left > 0; ) { d += step; if (isWorkday(d, hol)) left--; }
  return dateV(d);
});

// Financial
def("PMT", (a) => res(pmtF(nv(a, 0), nv(a, 1), nv(a, 2), nv(a, 3, 0), nv(a, 4, 0)), curOf(a, [2, 3])));
def("FV", (a) => res(fvF(nv(a, 0), nv(a, 1), nv(a, 2), nv(a, 3, 0), nv(a, 4, 0)), curOf(a, [2, 3])));
def("PV", (a) => res(pvF(nv(a, 0), nv(a, 1), nv(a, 2), nv(a, 3, 0), nv(a, 4, 0)), curOf(a, [2, 3])));
def("NPER", (a) => {
  const r = nv(a, 0), pmt = nv(a, 1), pv = nv(a, 2), fv = nv(a, 3, 0), type = nv(a, 4, 0);
  if (r === 0) return pmt === 0 ? E("#NUM!") : res(-(pv + fv) / pmt);
  const k = pmt * (1 + r * type);
  return res(Math.log((k - fv * r) / (k + pv * r)) / Math.log(1 + r));
});
def("IPMT", (a) => res(ipmtF(nv(a, 0), nv(a, 1), nv(a, 2), nv(a, 3), nv(a, 4, 0), nv(a, 5, 0)), curOf(a, [3, 4])));
def("PPMT", (a) => {
  const r = nv(a, 0), per = nv(a, 1), n = nv(a, 2), pv = nv(a, 3), fv = nv(a, 4, 0), type = nv(a, 5, 0);
  return res(pmtF(r, n, pv, fv, type) - ipmtF(r, per, n, pv, fv, type), curOf(a, [3, 4]));
});
def("NPV", (a) => {
  const r = nv(a, 0), v = numsOf(a, 1);
  return res(v.reduce((s, x, i) => s + x.n / pow1(r, i + 1), 0), unitOf(v) === "cur" ? "cur" : "");
});
def("RATE", (a) => {
  const n = nv(a, 0), pmt = nv(a, 1), pv = nv(a, 2), fv = nv(a, 3, 0), type = nv(a, 4, 0);
  return res(newton((r) => (Math.abs(r) < 1e-12 ? pv + pmt * n + fv : pv * pow1(r, n) + (pmt * (1 + r * type) * (pow1(r, n) - 1)) / r + fv), nv(a, 5, 0.1)));
});
def("IRR", (a) => {
  const xs = numbers(a, 0, 1);
  if (!xs.some((x) => x > 0) || !xs.some((x) => x < 0)) fail("#NUM!");
  return res(newton((r) => xs.reduce((s, x, i) => s + x / pow1(r, i), 0), nv(a, 1, 0.1)));
});

// Every function name the engine knows (sheetFunctions' autocomplete list is checked against this).
export const functionNames = (): string[] => Object.keys(FN);

// ── Entry points ─────────────────────────────────────────────────────────────────────────────────────
function literal(raw: string): V {
  const up = raw.trim().toUpperCase();
  if (up === "TRUE" || up === "FALSE") return B(up === "TRUE");
  const p = parseLiteral(raw);
  return p ? N(p.n, p.u) : S(raw);
}

function compile(body: string): Node { return parse(tokenize(body)); }

function evalFormula(body: string, get: CellGetter, stack: Set<string>, vars: VarMap, units: VarUnits): X {
  const ctx: Ctx = {
    vars, units,
    resolve(ref) {
      if (stack.has(ref)) throw new CycleError();
      const raw = (get(ref) ?? "").trim();
      if (raw === "") return BLANK;
      if (raw[0] !== "=") return literal(raw);
      let node: Node;
      try { node = compile(raw.slice(1)); } catch (e) { if (e instanceof ParseError) return E("#ERR"); throw e; }
      stack.add(ref);
      try { return scalar(ev(node, ctx)); } finally { stack.delete(ref); }
    },
  };
  return ev(compile(body), ctx);
}

// A formula body (no leading "=") as a typed number, or its text: a string result, "TRUE"/"FALSE", an Excel
// error code, "#ERR" (doesn't parse) or "#CYCLE" (circular reference). A blank result is 0, like Excel.
export function evalTyped(body: string, get: CellGetter, vars: VarMap = {}, units: VarUnits = {}): Val | string {
  let v: V;
  try { v = scalar(evalFormula(body, get, new Set(), vars, units)); }
  catch (e) {
    if (e instanceof CycleError) return "#CYCLE";
    if (e instanceof ParseError) return "#ERR";
    throw e;
  }
  switch (v.t) {
    case "n": return Number.isFinite(v.n) ? { n: v.n, u: v.u } : "#NUM!";
    case "z": return plain(0);
    case "s": return v.s;
    case "b": return v.b ? "TRUE" : "FALSE";
    case "e": return v.e;
  }
}

// A cell's computed value: a number for a numeric/formula cell (hours for times, dollars for money), the raw
// string for text, "" for empty, or the formula's text / error result (see evalTyped).
export function evaluateCell(raw: string, get: CellGetter, vars: VarMap = {}, units: VarUnits = {}): number | string {
  const s = (raw ?? "").trim();
  if (s === "") return "";
  if (s[0] !== "=") return NUM_RE.test(s) ? Number(s) : raw;
  const v = evalTyped(s.slice(1), get, vars, units);
  return typeof v === "string" ? v : v.n;
}

// Like evaluateCell for a formula, but formatted with its unit ("2 hours", "$40.00", "1:15 AM").
export function evaluateCellDisplay(raw: string, get: CellGetter, vars: VarMap = {}, units: VarUnits = {}): string {
  const s = (raw ?? "").trim();
  if (s[0] !== "=") return raw ?? "";
  const v = evalTyped(s.slice(1), get, vars, units);
  return typeof v === "string" ? v : formatValue(v);
}

// Evaluate a GLOBAL-ONLY expression (no spreadsheet cells) — used by tracker nodes and the server.
// $name references resolve against `vars`; a stray cell ref (e.g. A1) reads as blank (0). A leading "="
// is tolerated. Returns a number, or text / an error code (see evalTyped).
export function evaluateExpr(expr: string, vars: VarMap = {}, units: VarUnits = {}): number | string {
  const s = (expr ?? "").trim().replace(/^=/, "");
  if (s === "") return "";
  const v = evalTyped(s, () => "", vars, units);
  return typeof v === "string" ? v : v.n;
}
