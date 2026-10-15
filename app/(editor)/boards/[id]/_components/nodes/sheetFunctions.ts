// Formula autocomplete for spreadsheet cells: the function reference (arguments + one-line description,
// Excel's wording where it's clear) and the parsing that works out what to suggest at the caret.
// Pure (no React). scripts/test-sheetformula.mjs checks this list matches the engine's functions.

export type FnDoc = { name: string; args: string; desc: string };

const DOCS: Record<string, [string, string]> = {
  // Logical
  IF: ["condition, value_if_true, [value_if_false]", "One value if the condition is TRUE, another if FALSE"],
  IFS: ["condition1, value1, [condition2, value2, …]", "The value for the first condition that's TRUE"],
  AND: ["logical1, [logical2, …]", "TRUE if every argument is TRUE"],
  OR: ["logical1, [logical2, …]", "TRUE if any argument is TRUE"],
  XOR: ["logical1, [logical2, …]", "TRUE if an odd number of arguments are TRUE"],
  NOT: ["logical", "Flips TRUE and FALSE"],
  TRUE: ["", "The logical value TRUE"],
  FALSE: ["", "The logical value FALSE"],
  IFERROR: ["value, value_if_error", "The value, or a fallback if it's an error"],
  IFNA: ["value, value_if_na", "The value, or a fallback if it's #N/A"],
  SWITCH: ["expression, value1, result1, [value2, result2, …], [default]", "The result for the first value that matches"],
  CHOOSE: ["index, value1, [value2, …]", "Picks a value by its position"],
  // Information
  ISBLANK: ["value", "TRUE if the cell is empty"],
  ISNUMBER: ["value", "TRUE if the value is a number"],
  ISTEXT: ["value", "TRUE if the value is text"],
  ISNONTEXT: ["value", "TRUE if the value isn't text"],
  ISLOGICAL: ["value", "TRUE if the value is TRUE or FALSE"],
  ISERROR: ["value", "TRUE if the value is any error"],
  ISERR: ["value", "TRUE if the value is an error other than #N/A"],
  ISNA: ["value", "TRUE if the value is #N/A"],
  ISEVEN: ["number", "TRUE if the number is even"],
  ISODD: ["number", "TRUE if the number is odd"],
  N: ["value", "The value as a number (text becomes 0)"],
  T: ["value", "The value if it's text, else empty"],
  NA: ["", "The #N/A error"],
  TYPE: ["value", "1 number, 2 text, 4 logical, 16 error, 64 array"],
  "ERROR.TYPE": ["error_value", "A number for the kind of error"],
  // Math
  SUM: ["value1, [value2, …]", "Adds numbers and ranges"],
  PRODUCT: ["value1, [value2, …]", "Multiplies numbers and ranges"],
  SUMSQ: ["value1, [value2, …]", "Sum of the squares"],
  SUMPRODUCT: ["array1, [array2, …]", "Multiplies matching items, then adds them up"],
  ABS: ["number", "Absolute value"],
  ROUND: ["number, [digits]", "Rounds to a number of digits"],
  ROUNDUP: ["number, [digits]", "Rounds away from zero"],
  ROUNDDOWN: ["number, [digits]", "Rounds toward zero"],
  TRUNC: ["number, [digits]", "Cuts off digits without rounding"],
  INT: ["number", "Rounds down to a whole number"],
  MROUND: ["number, multiple", "Rounds to the nearest multiple"],
  CEILING: ["number, [significance]", "Rounds up to a multiple"],
  "CEILING.MATH": ["number, [significance], [mode]", "Rounds up to a multiple"],
  "CEILING.PRECISE": ["number, [significance]", "Rounds up to a multiple"],
  "ISO.CEILING": ["number, [significance]", "Rounds up to a multiple"],
  FLOOR: ["number, [significance]", "Rounds down to a multiple"],
  "FLOOR.MATH": ["number, [significance], [mode]", "Rounds down to a multiple"],
  "FLOOR.PRECISE": ["number, [significance]", "Rounds down to a multiple"],
  EVEN: ["number", "Rounds up to the next even number"],
  ODD: ["number", "Rounds up to the next odd number"],
  MOD: ["number, divisor", "Remainder after division"],
  QUOTIENT: ["numerator, denominator", "Whole-number part of a division"],
  SIGN: ["number", "1, 0 or -1"],
  POWER: ["number, power", "A number raised to a power"],
  SQRT: ["number", "Square root"],
  SQRTPI: ["number", "Square root of number × π"],
  EXP: ["number", "e raised to a power"],
  LN: ["number", "Natural logarithm"],
  LOG: ["number, [base]", "Logarithm (base 10 by default)"],
  LOG10: ["number", "Base-10 logarithm"],
  PI: ["", "π"],
  RAND: ["", "Random number from 0 to 1"],
  RANDBETWEEN: ["low, high", "Random whole number in a range"],
  FACT: ["number", "Factorial"],
  FACTDOUBLE: ["number", "Double factorial"],
  COMBIN: ["n, k", "Number of combinations"],
  PERMUT: ["n, k", "Number of permutations"],
  GCD: ["number1, [number2, …]", "Greatest common divisor"],
  LCM: ["number1, [number2, …]", "Least common multiple"],
  DEGREES: ["radians", "Radians to degrees"],
  RADIANS: ["degrees", "Degrees to radians"],
  SIN: ["angle", "Sine (radians)"],
  COS: ["angle", "Cosine (radians)"],
  TAN: ["angle", "Tangent (radians)"],
  ASIN: ["number", "Arcsine"],
  ACOS: ["number", "Arccosine"],
  ATAN: ["number", "Arctangent"],
  ATAN2: ["x, y", "Arctangent of a point"],
  SINH: ["number", "Hyperbolic sine"],
  COSH: ["number", "Hyperbolic cosine"],
  TANH: ["number", "Hyperbolic tangent"],
  ASINH: ["number", "Inverse hyperbolic sine"],
  ACOSH: ["number", "Inverse hyperbolic cosine"],
  ATANH: ["number", "Inverse hyperbolic tangent"],
  // Statistics
  AVERAGE: ["value1, [value2, …]", "Average of numbers and ranges"],
  AVG: ["value1, [value2, …]", "Average (same as AVERAGE)"],
  AVERAGEA: ["value1, [value2, …]", "Average, counting text as 0 and TRUE as 1"],
  MIN: ["value1, [value2, …]", "Smallest number"],
  MAX: ["value1, [value2, …]", "Largest number"],
  MINA: ["value1, [value2, …]", "Smallest, counting text and logicals"],
  MAXA: ["value1, [value2, …]", "Largest, counting text and logicals"],
  COUNT: ["value1, [value2, …]", "How many numbers"],
  COUNTA: ["value1, [value2, …]", "How many non-empty cells"],
  COUNTBLANK: ["range", "How many empty cells"],
  MEDIAN: ["value1, [value2, …]", "Middle number"],
  MODE: ["value1, [value2, …]", "Most common number"],
  "MODE.SNGL": ["value1, [value2, …]", "Most common number"],
  LARGE: ["range, k", "The k-th largest number"],
  SMALL: ["range, k", "The k-th smallest number"],
  RANK: ["number, range, [ascending]", "A number's rank in a list"],
  "RANK.EQ": ["number, range, [ascending]", "A number's rank in a list"],
  PERCENTILE: ["range, k", "The k-th percentile (k from 0 to 1)"],
  "PERCENTILE.INC": ["range, k", "The k-th percentile (k from 0 to 1)"],
  QUARTILE: ["range, quart", "A quartile (0–4)"],
  "QUARTILE.INC": ["range, quart", "A quartile (0–4)"],
  STDEV: ["value1, [value2, …]", "Standard deviation of a sample"],
  "STDEV.S": ["value1, [value2, …]", "Standard deviation of a sample"],
  STDEVP: ["value1, [value2, …]", "Standard deviation of a population"],
  "STDEV.P": ["value1, [value2, …]", "Standard deviation of a population"],
  VAR: ["value1, [value2, …]", "Variance of a sample"],
  "VAR.S": ["value1, [value2, …]", "Variance of a sample"],
  VARP: ["value1, [value2, …]", "Variance of a population"],
  "VAR.P": ["value1, [value2, …]", "Variance of a population"],
  AVEDEV: ["value1, [value2, …]", "Average distance from the mean"],
  GEOMEAN: ["value1, [value2, …]", "Geometric mean"],
  HARMEAN: ["value1, [value2, …]", "Harmonic mean"],
  CORREL: ["range1, range2", "Correlation between two ranges"],
  PEARSON: ["range1, range2", "Correlation between two ranges"],
  // Conditional totals
  COUNTIF: ["range, criteria", 'How many cells match, e.g. ">5" or "app*"'],
  COUNTIFS: ["range1, criteria1, [range2, criteria2, …]", "How many rows match every condition"],
  SUMIF: ["range, criteria, [sum_range]", "Adds the cells that match"],
  SUMIFS: ["sum_range, range1, criteria1, [range2, criteria2, …]", "Adds the cells where every condition matches"],
  AVERAGEIF: ["range, criteria, [average_range]", "Average of the cells that match"],
  AVERAGEIFS: ["average_range, range1, criteria1, […]", "Average where every condition matches"],
  MAXIFS: ["max_range, range1, criteria1, […]", "Largest where every condition matches"],
  MINIFS: ["min_range, range1, criteria1, […]", "Smallest where every condition matches"],
  // Text
  CONCAT: ["text1, [text2, …]", "Joins text and ranges"],
  CONCATENATE: ["text1, [text2, …]", "Joins text"],
  TEXTJOIN: ["delimiter, ignore_empty, text1, [text2, …]", "Joins text with a separator"],
  LEFT: ["text, [count]", "First characters"],
  RIGHT: ["text, [count]", "Last characters"],
  MID: ["text, start, count", "Characters from the middle"],
  LEN: ["text", "Number of characters"],
  UPPER: ["text", "UPPER CASE"],
  LOWER: ["text", "lower case"],
  PROPER: ["text", "Capitalizes Each Word"],
  TRIM: ["text", "Removes extra spaces"],
  CLEAN: ["text", "Removes non-printing characters"],
  SUBSTITUTE: ["text, old, new, [instance]", "Replaces text by matching it"],
  REPLACE: ["text, start, count, new", "Replaces text by position"],
  FIND: ["find, within, [start]", "Position of text (case-sensitive)"],
  SEARCH: ["find, within, [start]", "Position of text (ignores case, allows * ?)"],
  REPT: ["text, times", "Repeats text"],
  EXACT: ["text1, text2", "TRUE if two texts match exactly"],
  VALUE: ["text", "Text to a number"],
  NUMBERVALUE: ["text", "Text to a number"],
  TEXT: ["value, format", 'Formats a value, e.g. "$#,##0.00" or "mmm d, yyyy"'],
  FIXED: ["number, [decimals], [no_commas]", "A number as text with fixed decimals"],
  DOLLAR: ["number, [decimals]", "A number as currency text"],
  CHAR: ["number", "Character for a code"],
  CODE: ["text", "Code of the first character"],
  UNICHAR: ["number", "Unicode character for a code"],
  UNICODE: ["text", "Unicode value of the first character"],
  TEXTBEFORE: ["text, delimiter, [instance]", "Text before a delimiter"],
  TEXTAFTER: ["text, delimiter, [instance]", "Text after a delimiter"],
  // Lookup & reference
  VLOOKUP: ["lookup, table, column, [approximate]", "Looks down the first column and returns a value from that row"],
  HLOOKUP: ["lookup, table, row, [approximate]", "Looks across the first row and returns a value from that column"],
  XLOOKUP: ["lookup, lookup_range, return_range, [if_not_found], [match_mode], [search_mode]", "Finds a value and returns the matching item"],
  LOOKUP: ["lookup, lookup_range, [result_range]", "Finds a value in sorted data"],
  MATCH: ["lookup, range, [match_type]", "Position of a value in a range"],
  XMATCH: ["lookup, range, [match_mode], [search_mode]", "Position of a value in a range"],
  INDEX: ["range, row, [column]", "The value at a row and column"],
  ROWS: ["range", "Number of rows"],
  COLUMNS: ["range", "Number of columns"],
  ROW: ["cell", "Row number of a cell"],
  COLUMN: ["cell", "Column number of a cell"],
  TRANSPOSE: ["range", "Swaps rows and columns"],
  // Date & time
  TODAY: ["", "Today's date"],
  NOW: ["", "The current date and time"],
  DATE: ["year, month, day", "Builds a date"],
  TIME: ["hour, minute, second", "Builds a time"],
  TIMEVALUE: ["text", 'Text like "2:30 PM" to a time'],
  DATEVALUE: ["text", 'Text like "10/14/2026" to a date'],
  HOUR: ["time", "Hour (0–23)"],
  MINUTE: ["time", "Minute (0–59)"],
  SECOND: ["time", "Second (0–59)"],
  YEAR: ["date", "Year of a date"],
  MONTH: ["date", "Month of a date (1–12)"],
  DAY: ["date", "Day of the month"],
  WEEKDAY: ["date, [type]", "Day of the week (1 = Sunday by default)"],
  WEEKNUM: ["date, [type]", "Week of the year"],
  EDATE: ["start, months", "Same day some months later"],
  EOMONTH: ["start, months", "Last day of a month"],
  DAYS: ["end, start", "Days between two dates"],
  DATEDIF: ["start, end, unit", 'Time between dates in "Y", "M", "D", "YM", "MD" or "YD"'],
  NETWORKDAYS: ["start, end, [holidays]", "Working days between two dates"],
  WORKDAY: ["start, days, [holidays]", "The date some working days later"],
  // Financial
  PMT: ["rate, periods, present_value, [future_value], [type]", "Payment per period for a loan"],
  PV: ["rate, periods, payment, [future_value], [type]", "Present value of an investment"],
  FV: ["rate, periods, payment, [present_value], [type]", "Future value of an investment"],
  NPER: ["rate, payment, present_value, [future_value], [type]", "Number of payment periods"],
  NPV: ["rate, value1, [value2, …]", "Net present value of cash flows"],
  IPMT: ["rate, period, periods, present_value, [future_value], [type]", "Interest part of one payment"],
  PPMT: ["rate, period, periods, present_value, [future_value], [type]", "Principal part of one payment"],
  RATE: ["periods, payment, present_value, [future_value], [type], [guess]", "Interest rate per period"],
  IRR: ["values, [guess]", "Internal rate of return"],
};

export const FUNCTION_DOCS: FnDoc[] = Object.entries(DOCS).map(([name, [args, desc]]) => ({ name, args, desc }));
const BY_NAME = new Map(FUNCTION_DOCS.map((d) => [d.name, d]));
export const fnDoc = (name: string): FnDoc | undefined => BY_NAME.get(name.toUpperCase());

// Shown first when they match, the way Sheets ranks its everyday functions.
const COMMON = ["SUM", "IF", "AVERAGE", "COUNT", "MAX", "MIN", "ROUND", "SUMIF", "COUNTIF", "VLOOKUP", "XLOOKUP", "IFERROR", "CONCAT", "TODAY", "TEXT", "AND", "OR", "INDEX", "MATCH", "LEN"];

// What the caret is in the middle of typing in a formula: a function name, a $variable, or nothing.
export type Typing = { kind: "fn" | "var"; prefix: string; start: number } | null;
export function typingAt(text: string, caret: number): Typing {
  if (!/^\s*(=|\$[A-Za-z_][A-Za-z0-9_]*\s*=)/.test(text)) return null; // formulas and "$Name = formula" cells only
  const before = text.slice(0, caret);
  if (((before.match(/"/g) ?? []).length) % 2 === 1) return null; // inside a "string"
  let m = /\$([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
  if (m && !/^\s*\$[A-Za-z_][A-Za-z0-9_]*$/.test(before)) return { kind: "var", prefix: m[1] ?? "", start: m.index };
  m = /(^|[^A-Za-z0-9_.$])([A-Za-z][A-Za-z0-9.]*)$/.exec(before);
  if (m && !/\d/.test(m[2])) return { kind: "fn", prefix: m[2], start: m.index + m[1].length };
  return null;
}

// The function call the caret is inside, and which argument it's on (0-based), for the signature hint.
export function callAt(text: string, caret: number): { name: string; arg: number } | null {
  const stack: { name: string; arg: number }[] = [];
  let quoted = false;
  for (let i = 0; i < caret; i++) {
    const c = text[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === "(") {
      const name = /([A-Za-z][A-Za-z0-9.]*)\s*$/.exec(text.slice(0, i))?.[1] ?? "";
      stack.push({ name: name.toUpperCase(), arg: 0 });
    } else if (c === ")") stack.pop();
    else if (c === "," && stack.length) stack[stack.length - 1].arg++;
  }
  for (let k = stack.length - 1; k >= 0; k--) if (BY_NAME.has(stack[k].name)) return stack[k];
  return null;
}

// Functions starting with `prefix`: everyday ones first, then alphabetical.
export function suggestFunctions(prefix: string, limit = 8): FnDoc[] {
  const p = prefix.toUpperCase();
  if (!p) return [];
  const hits = FUNCTION_DOCS.filter((d) => d.name.startsWith(p) && d.name !== p);
  const rank = (d: FnDoc) => { const i = COMMON.indexOf(d.name); return i < 0 ? COMMON.length : i; };
  return hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, limit);
}

// Board variables starting with `prefix` (case-insensitive match, name kept as defined).
export const suggestVariables = (prefix: string, names: string[], limit = 8): string[] =>
  names.filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && n !== prefix).sort().slice(0, limit);

// Splits "a, [b, …]" into its top-level arguments so the hint can bold the one the caret is on.
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const c of args) {
    if (c === "[") depth++;
    if (c === "]") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Which listed argument to highlight: past the end, a repeating "…" argument stays highlighted.
export function argIndex(parts: string[], arg: number): number {
  if (arg < parts.length) return arg;
  return parts.length && parts[parts.length - 1].includes("…") ? parts.length - 1 : -1;
}
