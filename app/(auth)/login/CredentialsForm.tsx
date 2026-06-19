"use client";

import { useActionState } from "react";
import { loginAction } from "../actions";

// Email/password sign-in form. callbackUrl is resolved server-side (from searchParams) and passed in,
// so the page can stay a server component that decides which OAuth providers to show.
export function CredentialsForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <input
        name="email"
        type="email"
        required
        placeholder="Email"
        autoComplete="email"
        className="rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
      />
      <input
        name="password"
        type="password"
        required
        placeholder="Password"
        autoComplete="current-password"
        className="rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
      />
      {state?.error && <p className="text-sm text-error">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-control bg-primary px-4 py-2 font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98] disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
