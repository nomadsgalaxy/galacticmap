"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function ImportBoardButton() {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/boards/import", { method: "POST", body: fd });
      if (res.ok) {
        const { id } = (await res.json()) as { id: string };
        router.push(`/boards/${id}`);
        return;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Import failed");
    } catch {
      setError("Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => input.current?.click()}
        disabled={busy}
        className="rounded-control border border-outline-variant px-4 py-2 text-sm text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98] disabled:opacity-60"
      >
        {busy ? "Importing…" : "Import"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={onPick} />
    </div>
  );
}
