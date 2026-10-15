// Self-check for the spreadsheet formula evaluator. Run: npx tsx scripts/test-sheetformula.mjs
import { evaluateCell, evaluateCellDisplay, evaluateExpr, parseLiteral, parseRef, refName, colName } from "../app/(editor)/boards/[id]/_components/nodes/sheetFormula.ts";

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
eq("text in arithmetic is #VALUE! (Excel)", v("=C1+5"), "#VALUE!");
eq("divide", v("=A3/A1"), 2);
eq("bad formula", v("=A1+"), "#ERR");
eq("unknown fn", v("=BOGUS(A1)"), "#NAME?");
eq("bare range shows its first value", v("=A1:A3"), 2);

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

// --- typed values: time, duration, money ---
const lit = (s) => JSON.stringify(parseLiteral(s));
eq("lit 11:15 PM", lit("11:15 PM"), JSON.stringify({ n: 23.25, u: "time" }));
eq("lit 12:30 am", lit("12:30 am"), JSON.stringify({ n: 0.5, u: "time" }));
eq("lit 9pm", lit("9pm"), JSON.stringify({ n: 21, u: "time" }));
eq("lit 23:15", lit("23:15"), JSON.stringify({ n: 23.25, u: "time" }));
eq("lit 13:00 PM invalid", parseLiteral("13:00 PM"), null);
eq("lit $1,200.50", lit("$1,200.50"), JSON.stringify({ n: 1200.5, u: "cur" }));
eq("lit -$5", lit("-$5"), JSON.stringify({ n: -5, u: "cur" }));
eq("lit 1h 30m", lit("1h 30m"), JSON.stringify({ n: 1.5, u: "dur" }));
eq("lit 2 hours", lit("2 hours"), JSON.stringify({ n: 2, u: "dur" }));
eq("lit 45 min", lit("45 min"), JSON.stringify({ n: 0.75, u: "dur" }));
eq("lit 15%", lit("15%"), JSON.stringify({ n: 0.15, u: "" }));
eq("lit 1,200", lit("1,200"), JSON.stringify({ n: 1200, u: "" }));
eq("lit text", parseLiteral("hello"), null);

const shift = { B2: "11:15 PM", C2: "1:15 AM", D2: "=C2-B2", E2: "$20", F2: "9:00 AM", G2: "5:30 PM", H2: "1,200", I2: "15%" };
const gs = (r) => shift[r] ?? "";
const d = (raw) => evaluateCellDisplay(raw, gs);
eq("time diff past midnight", d("=C2-B2"), "2 hours");
eq("time diff number", evaluateCell("=C2-B2", gs), 2);
eq("same-day diff", d("=G2-F2"), "8 hours 30 min");
eq("$ literal × duration", d("=$20*D2"), "$40.00");
eq("money cell × duration", d("=E2*D2"), "$40.00");
eq("duration × money (parens)", d("=(C2-B2)*$20"), "$40.00");
eq("duration × number", d("=D2*3"), "6 hours");
eq("time + duration", d("=B2+D2"), "1:15 AM");
eq("money / duration = rate", d("=$40/D2"), "$20.00");
eq("money / money = ratio", d("=$40/E2"), "2");
eq("SUM money", d("=SUM(E2,E2)"), "$40.00");
eq("big money formatting", d("=$1000*H2"), "$1,200,000.00");
eq("percent", d("=H2*I2"), "180");
eq("plain display", d("=1/3"), "0.333333");
eq("display err", d("=C2+"), "#ERR");
eq("$var still works", evaluateCellDisplay("=$cost*2", gs, vars), "180");
eq("evaluateExpr $ literal", evaluateExpr("$20*2"), 40);

// --- Excel functions ---
const xl = {
  A1: "Apple", A2: "Banana", A3: "Cherry", A4: "apple pie",
  B1: "10", B2: "20", B3: "30", B4: "40",
  C1: "TRUE", C2: "FALSE", C3: "", C4: "x",
  D1: "10/14/2026", D2: "1/1/2026", D3: "$100", D4: "=1/0",
  E1: "1", E2: "2", E3: "2", E4: "5",
};
const gx = (r) => xl[r] ?? "";
const x = (f) => evaluateCellDisplay(f, gx);
// operators
eq("compare >", x("=B2>B1"), "TRUE");
eq("compare = text case-insens", x('=A1="APPLE"'), "TRUE");
eq("compare <>", x("=B1<>10"), "FALSE");
eq("concat &", x('=A1&" "&B1'), "Apple 10");
eq("power + precedence", x("=2+3^2*2"), "20");
eq("unary minus binds before ^", x("=-2^2"), "4");
eq("percent postfix", x("=50%*B4"), "20");
eq("string literal escapes", x('="say ""hi"""'), 'say "hi"');
eq("absolute refs", x("=$B$1+B$2+$B3"), "60");
eq("whole column", x("=SUM(B:B)"), "100");
eq("array math in SUMPRODUCT", x("=SUMPRODUCT((B1:B4>15)*B1:B4)"), "90");
eq("div by zero", x("=1/0"), "#DIV/0!");
eq("error propagates from cell", x("=D4+1"), "#DIV/0!");
// logical
eq("IF true", x('=IF(B1>5,"big","small")'), "big");
eq("IF false", x('=IF(B1>50,"big","small")'), "small");
eq("IF no else", x("=IF(B1>50,1)"), "FALSE");
eq("IF lazy (no #DIV/0!)", x("=IF(TRUE,1,1/0)"), "1");
eq("nested IF", x('=IF(B3>25,IF(B3>35,"A","B"),"C")'), "B");
eq("IFS", x('=IFS(B1>20,"a",B1>5,"b")'), "b");
eq("IFS no match", x("=IFS(FALSE,1)"), "#N/A");
eq("AND/OR/NOT", x("=AND(B1>5,OR(FALSE,NOT(FALSE)))"), "TRUE");
eq("AND over range", x("=AND(C1:C2)"), "FALSE");
eq("XOR", x("=XOR(TRUE,TRUE,TRUE)"), "TRUE");
eq("IFERROR", x('=IFERROR(1/0,"oops")'), "oops");
eq("IFNA", x('=IFNA(MATCH("zzz",A1:A3,0),"none")'), "none");
eq("SWITCH", x('=SWITCH(B2,10,"ten",20,"twenty","other")'), "twenty");
eq("SWITCH default", x('=SWITCH(99,1,"one","other")'), "other");
eq("CHOOSE", x('=CHOOSE(2,"a","b","c")'), "b");
eq("TRUE literal cell", x("=IF(C1,1,0)"), "1");
// info
eq("ISBLANK", x("=ISBLANK(C3)"), "TRUE");
eq("ISNUMBER", x("=ISNUMBER(B1)"), "TRUE");
eq("ISTEXT", x("=ISTEXT(A1)"), "TRUE");
eq("ISERROR", x("=ISERROR(D4)"), "TRUE");
eq("ISNA", x("=ISNA(NA())"), "TRUE");
eq("ISEVEN/ISODD", x("=AND(ISEVEN(4),ISODD(-3))"), "TRUE");
// math
eq("ROUND half away from zero", x("=ROUND(2.675,2)"), "2.68");
eq("ROUND negative digits", x("=ROUND(1234,-2)"), "1200");
eq("ROUNDUP/ROUNDDOWN", x("=ROUNDUP(1.21,1)+ROUNDDOWN(-1.29,1)"), "0.1");
eq("ROUND keeps money", x("=ROUND(D3/3,2)"), "$33.33");
eq("INT negative", x("=INT(-1.5)"), "-2");
eq("TRUNC", x("=TRUNC(-1.59,1)"), "-1.5");
eq("MOD sign of divisor", x("=MOD(-3,2)"), "1");
eq("CEILING/FLOOR", x("=CEILING(4.2,0.5)+FLOOR(4.7,0.5)"), "9");
eq("MROUND", x("=MROUND(10,3)"), "9");
eq("EVEN/ODD", x("=EVEN(1.5)+ODD(2)"), "5");
eq("ABS/SIGN", x("=ABS(-4)*SIGN(-2)"), "-4");
eq("POWER/SQRT", x("=POWER(2,10)+SQRT(16)"), "1028");
eq("SQRT negative", x("=SQRT(-1)"), "#NUM!");
eq("LOG/LN/EXP", x("=LOG(1000)+LOG(8,2)+LN(EXP(1))"), "7");
eq("PRODUCT", x("=PRODUCT(B1:B2,2)"), "400");
eq("FACT/COMBIN/PERMUT", x("=FACT(5)+COMBIN(5,2)+PERMUT(5,2)"), "150");
eq("GCD/LCM", x("=GCD(12,18)+LCM(4,6)"), "18");
eq("SUMSQ", x("=SUMSQ(3,4)"), "25");
eq("QUOTIENT", x("=QUOTIENT(7,2)"), "3");
eq("trig", x("=ROUND(SIN(PI()/2)+DEGREES(PI()),6)"), "181");
// statistics
eq("AVERAGE ignores text", x("=AVERAGE(A1:B4)"), "25");
eq("AVERAGE empty", x("=AVERAGE(C3)"), "#DIV/0!");
eq("COUNT/COUNTA/COUNTBLANK", x("=COUNT(A1:B4)&\"/\"&COUNTA(A1:C4)&\"/\"&COUNTBLANK(C1:C4)"), "4/11/1");
eq("MEDIAN", x("=MEDIAN(E1:E4)"), "2");
eq("MODE", x("=MODE(E1:E4)"), "2");
eq("LARGE/SMALL", x("=LARGE(B1:B4,1)-SMALL(B1:B4,2)"), "20");
eq("RANK", x("=RANK(30,B1:B4)"), "2");
eq("PERCENTILE/QUARTILE", x("=PERCENTILE(B1:B4,0.5)+QUARTILE(B1:B4,4)"), "65");
eq("STDEV", x("=ROUND(STDEV(B1:B4),4)"), "12.9099");
eq("STDEV.P", x("=ROUND(STDEV.P(B1:B4),4)"), "11.1803");
eq("VAR", x("=ROUND(VAR(B1:B4),4)"), "166.6667");
eq("GEOMEAN", x("=GEOMEAN(2,8)"), "4");
eq("CORREL", x("=CORREL(B1:B4,B1:B4)"), "1");
eq("MAX/MIN", x("=MAX(B1:B4)-MIN(B1:B4)"), "30");
// conditional totals
eq("COUNTIF >", x('=COUNTIF(B1:B4,">15")'), "3");
eq("COUNTIF wildcard", x('=COUNTIF(A1:A4,"app*")'), "2");
eq("COUNTIF exact text", x('=COUNTIF(A1:A4,"banana")'), "1");
eq("COUNTIF <>", x('=COUNTIF(A1:A4,"<>Apple")'), "3");
eq("COUNTIF number", x("=COUNTIF(E1:E4,2)"), "2");
eq("SUMIF", x('=SUMIF(A1:A4,"*e*",B1:B4)'), "80");
eq("SUMIFS", x('=SUMIFS(B1:B4,B1:B4,">10",A1:A4,"<>Cherry")'), "60");
eq("COUNTIFS", x('=COUNTIFS(B1:B4,">10",E1:E4,2)'), "2");
eq("AVERAGEIF", x('=AVERAGEIF(B1:B4,">15")'), "30");
eq("MAXIFS/MINIFS", x('=MAXIFS(B1:B4,A1:A4,"a*")-MINIFS(B1:B4,A1:A4,"a*")'), "30");
// text
eq("LEFT/RIGHT/MID", x('=LEFT(A2,3)&RIGHT(A2,2)&MID(A2,2,3)'), "Bannaana");
eq("LEN/UPPER/LOWER", x("=LEN(A3)&UPPER(A1)&LOWER(A2)"), "6APPLEbanana");
eq("PROPER", x('=PROPER("hello wORLD")'), "Hello World");
eq("TRIM", x('=TRIM("  a   b  ")'), "a b");
eq("SUBSTITUTE", x('=SUBSTITUTE("a-b-c","-","+")'), "a+b+c");
eq("SUBSTITUTE nth", x('=SUBSTITUTE("a-b-c","-","+",2)'), "a-b+c");
eq("REPLACE", x('=REPLACE("abcdef",2,3,"X")'), "aXef");
eq("FIND case-sensitive", x('=FIND("p",A1)'), "2");
eq("FIND missing", x('=FIND("z",A1)'), "#VALUE!");
eq("SEARCH case-insensitive", x('=SEARCH("PIE",A4)'), "7");
eq("REPT", x('=REPT("ab",3)'), "ababab");
eq("EXACT", x('=EXACT("a","A")'), "FALSE");
eq("VALUE", x('=VALUE("1,200")+1'), "1201");
eq("CONCAT range", x("=CONCAT(E1:E4)"), "1225");
eq("CONCATENATE", x('=CONCATENATE("a",1,TRUE)'), "a1TRUE");
eq("TEXTJOIN", x('=TEXTJOIN(", ",TRUE,A1:A3,C3)'), "Apple, Banana, Cherry");
eq("TEXT number", x('=TEXT(1234.5,"$#,##0.00")'), "$1,234.50");
eq("TEXT percent", x('=TEXT(0.256,"0.0%")'), "25.6%");
eq("TEXT date", x('=TEXT(D1,"mmm d, yyyy")'), "Oct 14, 2026");
eq("TEXT weekday", x('=TEXT(D1,"dddd")'), "Wednesday");
eq("TEXT time", x('=TEXT(TIME(14,5,0),"h:mm AM/PM")'), "2:05 PM");
eq("FIXED/DOLLAR", x('=FIXED(1234.567,1)&" "&DOLLAR(-5)'), "1,234.6 -$5.00");
eq("CHAR/CODE", x('=CHAR(65)&CODE("a")'), "A97");
eq("TEXTBEFORE/AFTER", x('=TEXTBEFORE("a@b.com","@")&"|"&TEXTAFTER("a@b.com","@")'), "a|b.com");
// lookup
eq("VLOOKUP exact", x('=VLOOKUP("banana",A1:B4,2,FALSE)'), "20");
eq("VLOOKUP missing", x('=VLOOKUP("kiwi",A1:B4,2,FALSE)'), "#N/A");
eq("VLOOKUP approx", x("=VLOOKUP(25,B1:B4,1)"), "20");
eq("VLOOKUP col out of range", x('=VLOOKUP("Apple",A1:B4,3,FALSE)'), "#REF!");
eq("HLOOKUP", x("=HLOOKUP(10,A1:B2,2,FALSE)"), "20");
eq("HLOOKUP on a column misses (Excel)", x("=HLOOKUP(2,E1:E4,1,FALSE)"), "#N/A");
eq("MATCH exact", x('=MATCH("Cherry",A1:A4,0)'), "3");
eq("MATCH approx", x("=MATCH(35,B1:B4)"), "3");
eq("INDEX", x("=INDEX(A1:B4,2,2)"), "20");
eq("INDEX/MATCH", x('=INDEX(B1:B4,MATCH("Cherry",A1:A4,0))'), "30");
eq("XLOOKUP", x('=XLOOKUP("Cherry",A1:A4,B1:B4)'), "30");
eq("XLOOKUP not found", x('=XLOOKUP("kiwi",A1:A4,B1:B4,"none")'), "none");
eq("XLOOKUP next larger", x("=XLOOKUP(25,B1:B4,A1:A4,,1)"), "Cherry");
eq("XMATCH last-to-first", x("=XMATCH(2,E1:E4,0,-1)"), "3");
eq("LOOKUP", x("=LOOKUP(25,B1:B4,A1:A4)"), "Banana");
eq("ROWS/COLUMNS/ROW/COLUMN", x("=ROWS(A1:B4)&COLUMNS(A1:B4)&ROW(B3)&COLUMN(B3)"), "4232");
// dates & times
eq("date literal displays", x("=D1"), "10/14/2026");
eq("date - date = days", x("=D1-D2"), "286");
eq("date + days", x("=D2+31"), "2/1/2026");
eq("DATE/YEAR/MONTH/DAY", x("=YEAR(D1)&MONTH(D1)&DAY(D1)"), "20261014");
eq("DATE rolls months", x("=DATE(2026,13,1)"), "1/1/2027");
eq("TIME/HOUR/MINUTE/SECOND", x("=HOUR(TIME(13,45,30))&MINUTE(TIME(13,45,30))&SECOND(TIME(13,45,30))"), "134530");
eq("HOUR of a time cell", x('=HOUR("11:15 PM")'), "23");
eq("TIMEVALUE", x('=TIMEVALUE("2:30 PM")'), "2:30 PM");
eq("WEEKDAY", x("=WEEKDAY(D1)&WEEKDAY(D1,2)"), "43");
eq("EDATE/EOMONTH", x("=EDATE(DATE(2026,1,31),1)&\" \"&EOMONTH(D1,0)"), "2/28/2026 10/31/2026");
eq("DAYS", x("=DAYS(D1,D2)"), "286");
eq("DATEDIF", x('=DATEDIF(DATE(2020,3,15),D1,"Y")&DATEDIF(DATE(2020,3,15),D1,"YM")&DATEDIF(DATE(2020,3,15),D1,"MD")'), "6629");
eq("NETWORKDAYS", x("=NETWORKDAYS(DATE(2026,10,12),DATE(2026,10,18))"), "5");
eq("WORKDAY", x("=WORKDAY(DATE(2026,10,16),1)"), "10/19/2026");
eq("WEEKNUM", x("=WEEKNUM(DATE(2026,1,4))"), "2");
eq("datetime literal", evaluateCellDisplay("=A1", (r) => (r === "A1" ? "10/14/2026 4:30 PM" : "")), "10/14/2026 4:30 PM");
eq("TODAY is a date", x("=ISNUMBER(TODAY())"), "TRUE");
// financial (Excel reference values)
eq("PMT", x("=ROUND(PMT(0.05/12,360,200000),2)"), "-1073.64");
eq("PMT keeps money", x("=PMT(0,10,$1000)"), "-$100.00");
eq("FV", x("=ROUND(FV(0.06/12,10,-200,-500,1),2)"), "2581.4");
eq("PV", x("=ROUND(PV(0.08/12,240,500),2)"), "-59777.15");
eq("NPER", x("=ROUND(NPER(0.01,-100,1000),4)"), "10.5886");
eq("NPV", x("=ROUND(NPV(0.1,-10000,3000,4200,6800),2)"), "1188.44");
eq("IPMT/PPMT", x("=ROUND(IPMT(0.1,1,2,1000),2)&\" \"&ROUND(PPMT(0.1,1,2,1000),2)"), "-100 -476.19");
eq("RATE", x("=ROUND(RATE(48,-200,8000),6)"), "0.007701");
eq("IRR", x("=ROUND(IRR(E1:E4),4)"), "#NUM!");
const cash = { A1: "-70000", A2: "12000", A3: "15000", A4: "18000", A5: "21000", A6: "26000" };
eq("IRR real", evaluateCellDisplay("=ROUND(IRR(A1:A6),4)", (r) => cash[r] ?? ""), "0.0866");

// --- variables carrying a unit ---
const units = { rate: "cur" };
const rv = { rate: [20], cost: [30, 30, 30] };
eq("$rate × duration", evaluateCellDisplay("=$rate*D2", gs, rv, units), "$40.00");
eq("Sum($rate) keeps $", evaluateCellDisplay("=SUM($rate)*2", gs, rv, units), "$40.00");
eq("untyped var stays plain", evaluateCellDisplay("=$cost*D2", gs, rv, units), "180 hours");
eq("evaluateExpr typed var", evaluateExpr("$rate*3", rv, units), 60);

console.log(`\nsheetFormula — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
