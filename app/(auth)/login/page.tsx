import { Suspense } from "react";
import Link from "next/link";
import { oauthSignIn } from "../actions";
import { CredentialsForm } from "./CredentialsForm";

// Dynamic so the OAuth buttons reflect RUNTIME env (a provider shows only when its keys are set, like
// auth.ts). Next 16 cacheComponents: the part that reads searchParams must live inside <Suspense>.
export default function LoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-on-background">Sign in to Galactic Map</h1>
        <p className="mt-1 text-sm text-on-surface-variant">Welcome back.</p>
      </div>

      <Suspense fallback={<CredentialsForm callbackUrl="/" />}>
        <SignInOptions searchParams={searchParams} />
      </Suspense>

      <p className="text-center text-sm text-on-surface-variant">
        No account?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Sign up
        </Link>
      </p>
    </main>
  );
}

async function SignInOptions({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const raw = (await searchParams)?.callbackUrl;
  const callbackUrl = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  const githubEnabled = !!(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
  const gitlabEnabled = !!(process.env.AUTH_GITLAB_ID && process.env.AUTH_GITLAB_SECRET);

  const oauthBtn =
    "flex w-full items-center justify-center gap-2 rounded-control border border-outline-variant bg-surface px-4 py-2 text-sm font-medium text-on-surface transition hover:bg-surface-variant active:scale-[.98]";

  return (
    <>
      {(githubEnabled || gitlabEnabled) && (
        <div className="flex flex-col gap-2">
          {githubEnabled && (
            <form action={oauthSignIn}>
              <input type="hidden" name="provider" value="github" />
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <button type="submit" className={oauthBtn}>
                <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
                Continue with GitHub
              </button>
            </form>
          )}
          {gitlabEnabled && (
            <form action={oauthSignIn}>
              <input type="hidden" name="provider" value="gitlab" />
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <button type="submit" className={oauthBtn}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.452.044 13.587a.924.924 0 00.331 1.03L12 23.054l11.625-8.436a.92.92 0 00.33-1.031"></path></svg>
                Continue with GitLab
              </button>
            </form>
          )}
          <div className="flex items-center gap-3 text-xs text-on-surface-variant">
            <span className="h-px flex-1 bg-outline-variant" /> or <span className="h-px flex-1 bg-outline-variant" />
          </div>
        </div>
      )}

      <CredentialsForm callbackUrl={callbackUrl} />
    </>
  );
}
