"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { loginAction } from "../actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  const [callbackUrl, setCallbackUrl] = useState("/");

  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get("callbackUrl");
    if (u && u.startsWith("/") && !u.startsWith("//")) setCallbackUrl(u);
  }, []);

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-on-background">Sign in to Galactic Map</h1>
        <p className="mt-1 text-sm text-on-surface-variant">Welcome back.</p>
      </div>
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
      <p className="text-center text-sm text-on-surface-variant">
        No account?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Sign up
        </Link>
      </p>
    </main>
  );
}
