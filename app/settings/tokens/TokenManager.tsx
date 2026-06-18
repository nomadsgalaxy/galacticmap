"use client";

import { useState, useTransition } from "react";
import { createApiToken, revokeApiToken } from "@/app/lib/token-actions";

type TokenRow = {
  id: string;
  name: string;
  scopes: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
};

export function TokenManager({ initial }: { initial: TokenRow[] }) {
  const [tokens, setTokens] = useState<TokenRow[]>(initial);
  const [fresh, setFresh] = useState<{ id: string; raw: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  async function onCreate(formData: FormData) {
    const result = await createApiToken(formData);
    setFresh(result);
    setCopied(false);
    // Optimistically reflect it in the list; the server is the source of truth on reload.
    setTokens((prev) => [
      {
        id: result.id,
        name: (formData.get("name")?.toString().trim() || "API token").slice(0, 80),
        scopes: formData.get("scope")?.toString() === "read" ? "read" : "read,write",
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
      ...prev,
    ]);
  }

  function onRevoke(id: string) {
    start(async () => {
      await revokeApiToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      if (fresh?.id === id) setFresh(null);
    });
  }

  return (
    <div className="space-y-6">
      <form
        action={onCreate}
        className="rounded-panel border border-outline-variant bg-surface-container p-4"
      >
        <h2 className="mb-1 text-sm font-semibold text-on-surface">Create a token</h2>
        <p className="mb-3 text-xs text-on-surface-variant">
          Use it as a Bearer token against <code className="rounded bg-surface-variant px-1 py-0.5">/api/v1</code> or in the MCP server.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
            Name
            <input
              name="name"
              placeholder="My laptop"
              maxLength={80}
              className="w-56 rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
            Scope
            <select
              name="scope"
              defaultValue="read,write"
              className="rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
            >
              <option value="read,write">Read &amp; write</option>
              <option value="read">Read only</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-control bg-primary px-4 py-2 text-sm font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98]"
          >
            Generate
          </button>
        </div>
      </form>

      {fresh && (
        <div className="gb-pop-in rounded-panel border border-primary/40 bg-primary-container p-4 text-on-primary-container">
          <div className="mb-1 text-sm font-semibold">Copy your new token now</div>
          <p className="mb-2 text-xs opacity-80">
            This is the only time it will be shown. Store it somewhere safe.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-control bg-surface px-3 py-2 font-mono text-xs text-on-surface">
              {fresh.raw}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(fresh.raw).then(() => setCopied(true));
              }}
              className="rounded-control bg-primary px-3 py-2 text-xs font-medium text-on-primary transition hover:opacity-90 active:scale-[.98]"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-on-surface">Your tokens ({tokens.length})</h2>
        {tokens.length === 0 ? (
          <p className="rounded-panel border border-dashed border-outline-variant bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
            No tokens yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 rounded-panel border border-outline-variant bg-surface-container p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-on-surface">{t.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-on-surface-variant">
                    <span className="rounded bg-surface-variant px-1.5 py-0.5">{t.scopes}</span>
                    <span>created {new Date(t.createdAt).toLocaleDateString()}</span>
                    <span>{t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}</span>
                  </div>
                </div>
                <button
                  onClick={() => onRevoke(t.id)}
                  disabled={pending}
                  className="rounded-control px-3 py-1.5 text-xs text-error transition hover:bg-error-container hover:text-on-error-container active:scale-[.98] disabled:opacity-50"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
