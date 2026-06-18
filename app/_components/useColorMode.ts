"use client";

import { useEffect, useState } from "react";

// Effective light/dark mode, tracking ThemeForge's forced variant (data-theme-variant on <html>)
// and falling back to the OS preference. Used to drive React Flow's `colorMode` so its Controls /
// MiniMap / handles match the app theme (RF12 gates its dark styles on .react-flow.dark).
export function useColorMode(): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">("light");
  useEffect(() => {
    const compute = (): "light" | "dark" => {
      const v = document.documentElement.getAttribute("data-theme-variant");
      if (v === "dark") return "dark";
      if (v === "light") return "light";
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    };
    setMode(compute());
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMq = () => setMode(compute());
    mq?.addEventListener?.("change", onMq);
    const obs = new MutationObserver(() => setMode(compute()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-variant"] });
    return () => {
      mq?.removeEventListener?.("change", onMq);
      obs.disconnect();
    };
  }, []);
  return mode;
}
