"use client";

import { useEffect, useState } from "react";

export function CopyField({ path }: { path: string }) {
  const [url, setUrl] = useState(path);
  const [copied, setCopied] = useState(false);
  useEffect(() => setUrl(window.location.origin + path), [path]);

  return (
    <div className="flex items-center gap-2 rounded-control bg-surface-variant p-2">
      <code className="flex-1 truncate text-xs text-on-surface-variant">{url}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="rounded-control bg-primary px-2 py-1 text-xs font-medium text-on-primary transition hover:opacity-90 active:scale-[.98]"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
