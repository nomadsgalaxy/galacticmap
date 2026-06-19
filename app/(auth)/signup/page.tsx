import { Suspense } from "react";
import { redirect } from "next/navigation";
import { passwordLoginEnabled } from "@/app/lib/auth-config";
import { SignupForm } from "./SignupForm";

export default function SignupPage({ searchParams }: { searchParams: Promise<unknown> }) {
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-on-background">Create your account</h1>
        <p className="mt-1 text-sm text-on-surface-variant">Start building boards.</p>
      </div>
      <Suspense fallback={<p className="text-center text-sm text-on-surface-variant">Loading…</p>}>
        <Gate searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Gate({ searchParams }: { searchParams: Promise<unknown> }) {
  await searchParams; // read request data so this evaluates at runtime (env-gated, like /login)
  if (!passwordLoginEnabled()) redirect("/login"); // OAuth-only instance: no password sign-up
  return <SignupForm />;
}
