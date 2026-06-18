"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signupAction } from "../actions";

export default function SignupPage() {
  const [state, action, pending] = useActionState(signupAction, undefined);

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-on-background">Create your account</h1>
        <p className="mt-1 text-sm text-on-surface-variant">Start building boards.</p>
      </div>
      <form action={action} className="flex flex-col gap-3">
        <input
          name="name"
          type="text"
          placeholder="Name (optional)"
          autoComplete="name"
          className="rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
        />
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
          minLength={8}
          placeholder="Password (min 8 chars)"
          autoComplete="new-password"
          className="rounded-control border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
        />
        {state?.error && <p className="text-sm text-error">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="rounded-control bg-primary px-4 py-2 font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98] disabled:opacity-60"
        >
          {pending ? "Creating…" : "Sign up"}
        </button>
      </form>
      <p className="text-center text-sm text-on-surface-variant">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
