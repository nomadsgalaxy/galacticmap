"use client";

import { useEffect, useState } from "react";

// Platform-aware modifier label for keybinding HINTS. The shortcut handlers themselves accept both
// Ctrl and Cmd everywhere (e.ctrlKey || e.metaKey); this only changes what we DISPLAY so Mac users see
// ⌘ and Windows/Linux users see Ctrl. Detection is client-only (via navigator), so we default to
// "other" → "Ctrl" for SSR/first render (no hydration mismatch) and refine on mount.

export type OS = "mac" | "windows" | "linux" | "other";

// Pure classification from a platform / userAgent string (exported for testing). Order matters: macOS
// userAgents contain "Mac" (and iPad desktop-mode reports "MacIntel"), so check mac before the rest.
export function osFromPlatform(p: string): OS {
  const s = (p || "").toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(s)) return "mac";
  if (/win/.test(s)) return "windows";
  if (/linux|android|cros|chrome os|x11/.test(s)) return "linux";
  return "other";
}

function detectOS(): OS {
  if (typeof navigator === "undefined") return "other";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  // userAgentData.platform ("Windows"/"macOS"/"Linux") is the cleanest signal; fall back to the
  // deprecated-but-universal navigator.platform ("Win32"/"MacIntel"/"Linux x86_64") then userAgent.
  return osFromPlatform(nav.userAgentData?.platform || navigator.platform || navigator.userAgent || "");
}

export function useModKey() {
  const [os, setOs] = useState<OS>("other");
  useEffect(() => setOs(detectOS()), []);
  const isMac = os === "mac";
  const mod = isMac ? "⌘" : "Ctrl"; // ⌘ on macOS, Ctrl on Windows/Linux
  const sep = isMac ? "" : "+";
  // k("Z") -> "⌘Z" / "Ctrl+Z"; k("⇧Z") -> "⌘⇧Z" / "Ctrl+⇧Z"; k("↵") -> "⌘↵" / "Ctrl+↵"
  const k = (combo: string) => `${mod}${sep}${combo}`;
  return { os, isMac, mod, k };
}
