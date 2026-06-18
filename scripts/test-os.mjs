// Self-check for OS detection (keyboard-hint platform). Run: npx tsx scripts/test-os.mjs
import { osFromPlatform } from "../app/_components/useModKey.ts";

let pass = 0, fail = 0;
const eq = (input, want) => {
  const got = osFromPlatform(input);
  if (got === want) pass++; else { fail++; console.log(`  ✗ "${input}" → ${got} (want ${want})`); }
};

// navigator.userAgentData.platform values
eq("macOS", "mac"); eq("Windows", "windows"); eq("Linux", "linux"); eq("Chrome OS", "linux");
// navigator.platform values
eq("MacIntel", "mac"); eq("Win32", "windows"); eq("Linux x86_64", "linux"); eq("iPhone", "mac");
// full userAgent strings
eq("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "mac");
eq("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "windows");
eq("Mozilla/5.0 (X11; Linux x86_64)", "linux");
eq("Mozilla/5.0 (Linux; Android 13)", "linux");
// fallbacks
eq("", "other"); eq("FreeBSD", "other");

console.log(`\nos — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
