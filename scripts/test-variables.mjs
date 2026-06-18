// Self-check for the board-global variable scanner/aggregator. Run: npx tsx scripts/test-variables.mjs
import { VAR_DEF_RE, parseVarValue, stripVarTokens, scanText, scanVariables, aggregate, evaluateExpr, renderTrackerLine, cellOutput } from "../app/lib/variables.ts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  const ok = a === b || (typeof got === "number" && typeof want === "number" && Math.abs(got - want) < 1e-9);
  if (ok) pass++; else { fail++; console.log(`  ✗ ${name}: got ${a} want ${b}`); }
};

// parseVarValue — number extraction per grammar v2
eq("parseVarValue $40", parseVarValue("$40"), 40);
eq("parseVarValue $1,200.50", parseVarValue("$1,200.50"), 1200.5);
eq("parseVarValue 2.5kg", parseVarValue("2.5kg"), 2.5);
eq("parseVarValue -3", parseVarValue("-3"), -3);
eq("parseVarValue 10 units", parseVarValue("10 units"), 10);
eq("parseVarValue free → null", parseVarValue("free"), null);
eq("parseVarValue empty → null", parseVarValue(""), null);

// VAR_DEF_RE / scanText — content is verbatim; tracked value is the extracted number
eq("scanText two defs", scanText("price $cost(30) and $cost(20)"), [{ name: "cost", value: 30 }, { name: "cost", value: 20 }]);
eq("scanText decimal/negative", scanText("$a(2.5) $b(-3)"), [{ name: "a", value: 2.5 }, { name: "b", value: -3 }]);
eq("scanText none", scanText("plain text"), []);
eq("scanText non-numeric ignored", scanText("$x(hello) $y(7)"), [{ name: "y", value: 7 }]);
eq("scanText underscore names", scanText("$_a(1) $b_2(2)"), [{ name: "_a", value: 1 }, { name: "b_2", value: 2 }]);
eq("scanText verbatim content w/ symbols", scanText("$PricePer($40) $UnitsReq(10)"), [{ name: "PricePer", value: 40 }, { name: "UnitsReq", value: 10 }]);

// VAR_DEF_RE is a global regex
eq("VAR_DEF_RE global flag", VAR_DEF_RE.flags.includes("g"), true);

// stripVarTokens — variable tokens collapse to content VERBATIM; non-variable tokens untouched
eq("stripVarTokens", stripVarTokens("$cost(30) each"), "30 each");
eq("stripVarTokens multi", stripVarTokens("a $x(1) b $y(2.5) c"), "a 1 b 2.5 c");
eq("stripVarTokens leaves non-numeric", stripVarTokens("$x(hi)"), "$x(hi)");
eq("stripVarTokens verbatim content", stripVarTokens("$PricePer($40) • $UnitsReq(10)"), "$40 • 10");
eq("stripVarTokens leaves $x(free)", stripVarTokens("$x(free)"), "$x(free)");

// scanVariables over a fake node list (text + spreadsheet cells + per-node varText)
const nodes = [
  { type: "text", data: { text: "budget $cost(30) and $cost(20)" } },
  { type: "text", data: { text: "headcount $qty(5)" } },
  { type: "spreadsheet", data: { cells: { A1: "$cost(40)", A2: "=$cost*2", B1: "plain", C1: "$qty(3)" } } },
  { type: "image", data: { varText: "tag $qty(2)" } },        // ANY node type's varText is scanned
  { type: "weird", data: null },
];
const vars = scanVariables(nodes);
eq("scanVariables cost", vars.cost, [30, 20, 40]);
eq("scanVariables qty (incl varText)", vars.qty, [5, 3, 2]);
eq("scanVariables ignores formula cell", Object.keys(vars).sort(), ["cost", "qty"]);
eq("scanVariables null nodes", scanVariables(null), {});

// scanVariables reads data.varText with verbatim-content tokens; non-numeric token not tracked
const vt = scanVariables([{ type: "sticky", data: { varText: "$cost($40) and $note(free)" } }]);
eq("scanVariables varText cost=40", vt.cost, [40]);
eq("scanVariables varText skips non-numeric", Object.keys(vt).sort(), ["cost"]);

// aggregate
eq("aggregate", aggregate([30, 20, 40]), { sum: 90, avg: 30, min: 20, max: 40, count: 3 });
eq("aggregate empty", aggregate([]), { sum: 0, avg: 0, min: 0, max: 0, count: 0 });
eq("aggregate single", aggregate([7]), { sum: 7, avg: 7, min: 7, max: 7, count: 1 });

// evaluateExpr (shared impl)
eq("evaluateExpr Sum+Max", evaluateExpr("Sum($cost)+Max($qty)", vars), 90 + 5);
eq("evaluateExpr bare sum", evaluateExpr("$cost", vars), 90);
eq("evaluateExpr missing", evaluateExpr("Sum($nope)", vars), 0);

// renderTrackerLine — tracker line template (literal text + inline-substituted results)
const tvars = { ProjAPrice: [20, 40], cost: [10, 20, 30] };
eq("tracker example", renderTrackerLine("Price: $sum(ProjAPrice)", tvars), "Price: $60");
eq("tracker avg+text", renderTrackerLine("Avg: $avg(cost)", tvars), "Avg: $20");
eq("tracker count", renderTrackerLine("count(cost) items", tvars), "3 items");
eq("tracker $-prefixed arg", renderTrackerLine("$sum($cost)", tvars), "$60");
eq("tracker brace arithmetic", renderTrackerLine("{Sum($cost)*1.1}", tvars), "66");
eq("tracker plain text", renderTrackerLine("just a label", tvars), "just a label");
eq("tracker missing var", renderTrackerLine("$sum(nope)", tvars), "$0");

// cellOutput — "$Name = formula" named-output cells (vs literal tokens / plain formulas)
eq("cellOutput parse", cellOutput("$ProjACost = A1*A2"), { name: "ProjACost", expr: "A1*A2" });
eq("cellOutput literal-token is not output", cellOutput("$cost(30)"), null);
eq("cellOutput plain formula is not output", cellOutput("=A1*A2"), null);

// scanVariables — spreadsheet cell results exported to variables
{
  const out = scanVariables([
    { type: "spreadsheet", data: { cells: { A1: "3", A2: "4", A3: "$ProjACost = A1*A2", B1: "$cost(30)", C1: "$Doubled = Sum($cost)*2" } } },
    { type: "text", data: { text: "more $cost(20)" } },
  ]);
  eq("output ProjACost = A1*A2", out.ProjACost, [12]);
  eq("literal cost aggregated", out.cost, [30, 20]);
  eq("output uses literal var: Doubled = Sum(cost)*2", out.Doubled, [100]);
}

console.log(`\nvariables — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
