"use client";

import { useActionState, useState } from "react";
import { deleteAccount } from "./actions";

// Type-to-confirm (the account email) to arm the destructive action; the server re-validates.
export function DeleteAccount({ email }: { email: string }) {
  const [state, action, pending] = useActionState(deleteAccount, undefined);
  const [confirm, setConfirm] = useState("");
  const armed = confirm.trim().toLowerCase() === email.toLowerCase();

  return (
    <form action={action} className="flex flex-col gap-3">
      <p className="text-sm text-on-surface-variant">
        Type <strong className="text-on-surface">{email}</strong> to confirm.
      </p>
      <input
        name="confirm"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="off"
        placeholder={email}
        className="rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-error"
      />
      {state?.error && <p className="text-sm text-error">{state.error}</p>}
      <button
        type="submit"
        disabled={!armed || pending}
        className="self-start rounded-control bg-error px-4 py-2 text-sm font-medium text-on-error transition hover:opacity-90 active:scale-[.98] disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Delete everything"}
      </button>
    </form>
  );
}
