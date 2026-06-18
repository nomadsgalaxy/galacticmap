// Self-check for the spreadsheet formula evaluator. Run: npx tsx scripts/test-sheetformula.mjs
import { evaluateCell, evaluateExpr, parseRef, refName, colName } from "../app/(editor)/boards/[id]/_components/nodes/sheetFormula.ts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = got === want || (typeof got === "number" && typeof want === "number" && Math.abs(got - want) < 1e-9);
  if (ok) pass++; else { fail++; console.log(`  ✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// ref helpers
eq("colName 0", colName(0), "A");
eq("colName 26", colName(26), "AA");
eq("refName", refName(2, 4), "C5");
eq("parseRef B3", JSON.stringify(parseRef("B3")), JSON.stringify({ col: 1, row: 2 }));
eq("parseRef junk", parseRef("hello"), null);

// a small sheet: A1=2 A2=3 A3=4 B1="=A1+A2" B2="=SUM(A1:A3)" B3="=B1*2" C1="text"
const cells = { A1: "2", A2: "3", A3: "4", B1: "=A1+A2", B2: "=SUM(A1:A3)", B3: "=B1*2", C1: "text" };
const get = (r) => cells[r] ?? "";
const v = (raw) => evaluateCell(raw, get);

eq("number", v("42"), 42);
eq("negative", v("-7"), -7);
eq("decimal", v("3.5"), 3.5);
eq("text passthrough", v("hello"), "hello");
eq("empty", v(""), "");
eq("ref", v("=A1"), 2);
eq("add refs", v("=A1+A2"), 5);
eq("arithmetic precedence", v("=A1+A2*A3"), 2 + 3 * 4);
eq("parens", v("=(A1+A2)*A3"), (2 + 3) * 4);
eq("unary minus", v("=-A1+10"), 8);
eq("SUM range", v("=SUM(A1:A3)"), 9);
eq("AVERAGE", v("=AVERAGE(A1:A3)"), 3);
eq("AVG alias", v("=AVG(A1:A3)"), 3);
eq("MIN/MAX", v("=MIN(A1:A3)*MAX(A1:A3)"), 2 * 4);
eq("COUNT", v("=COUNT(A1:A3)"), 3);
eq("SUM mixed args", v("=SUM(A1:A2, A3, 1)"), 2 + 3 + 4 + 1);
eq("nested formula ref (B1=A1+A2)", v("=B1"), 5);
eq("formula referencing formula", v("=B2+B1"), 9 + 5);
eq("text cell as 0", v("=C1+5"), 5);
eq("divide", v("=A3/A1"), 2);
eq("bad formula", v("=A1+"), "#ERR");
eq("unknown fn", v("=BOGUS(A1)"), "#ERR");
eq("bare range outside fn", v("=A1:A3"), "#ERR");

// cycle detection
const cyc = { A1: "=B1", B1: "=A1", D1: "=D1" };
const gc = (r) => cyc[r] ?? "";
eq("mutual cycle", evaluateCell("=B1", gc), "#CYCLE");
eq("self cycle", evaluateCell("=D1", gc), "#CYCLE");

// --- $variable references (board-global) ---
const vars = { cost: [30, 30, 30], qty: [2, 5] };
const vv = (raw) => evaluateCell(raw, get, vars);
eq("Sum($cost)", vv("=Sum($cost)"), 90);
eq("Avg($cost)", vv("=Avg($cost)"), 30);
eq("Min($qty)", vv("=Min($qty)"), 2);
eq("Max($qty)", vv("=Max($qty)"), 5);
eq("Count($cost)", vv("=Count($cost)"), 3);
eq("bare $cost = SUM", vv("=$cost"), 90);
eq("Sum($cost)*1.1", vv("=Sum($cost)*1.1"), 99);
eq("bare $cost arithmetic", vv("=$cost*2"), 180);
eq("$cost + $qty (both sum)", vv("=$cost+$qty"), 90 + 7);
eq("missing var bare = 0", vv("=$nope+5"), 5);
eq("missing var Sum = 0", vv("=Sum($nope)"), 0);
eq("missing var Count = 0", vv("=Count($nope)"), 0);
eq("vars optional (no 3rd arg)", evaluateCell("=A1+A2", get), 5);

// evaluateExpr: global-only, cells resolve to 0
eq("evaluateExpr Sum", evaluateExpr("Sum($cost)", vars), 90);
eq("evaluateExpr with =", evaluateExpr("=Avg($cost)", vars), 30);
eq("evaluateExpr Sum+Max", evaluateExpr("Sum($cost)+Max($qty)", vars), 95);
eq("evaluateExpr stray ref = 0", evaluateExpr("A1+$cost", vars), 90);
eq("evaluateExpr empty", evaluateExpr("", vars), "");
eq("evaluateExpr bad", evaluateExpr("Sum($cost", vars), "#ERR");

console.log(`\nsheetFormula — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
