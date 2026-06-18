"use client";

import { useState } from "react";
import { inviteMember } from "@/app/lib/member-actions";
import { CopyField } from "@/app/_components/CopyField";

export function InviteForm({ boardId }: { boardId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("VISITOR");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    const res = await inviteMember(boardId, email, role);
    setBusy(false);
    if (res.ok) {
      setLink(res.path); // CopyField prepends window.location.origin
      setEmail("");
    } else {
      setError(res.error);
    }
  };

  return (
    <div className="rounded-panel border border-outline-variant bg-surface-container p-4">
      <h2 className="mb-2 text-sm font-semibold text-on-surface">Invite by link</h2>
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@example.com"
          className="flex-1 rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-control border border-outline-variant bg-surface px-2 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
        >
          <option value="VISITOR">Visitor (view)</option>
          <option value="TEAM">Team (edit)</option>
        </select>
        <button
          disabled={busy}
          className="rounded-control bg-primary px-4 py-2 text-sm font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98] disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create invite"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-error">{error}</p>}
      {link && <div className="mt-3"><CopyField path={link} /></div>}
      <p className="mt-2 text-xs text-on-surface-variant">
        Single-use, expires in 14 days. The recipient must sign in with this exact email.
      </p>
    </div>
  );
}
