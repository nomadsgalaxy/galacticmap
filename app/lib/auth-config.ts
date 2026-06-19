// Single source of truth for which auth methods are enabled (read at runtime, so env/deploys drive it).
// Used by auth.ts (which providers to register) and the login/signup pages (what to render) so they can
// never disagree.

export function oauthEnabled() {
  const github = !!(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
  const gitlab = !!(process.env.AUTH_GITLAB_ID && process.env.AUTH_GITLAB_SECRET);
  return { github, gitlab, any: github || gitlab };
}

// Email/password is on by default. Set AUTH_PASSWORD_DISABLED=true for an OAuth-only instance (e.g.
// chart.galacticmap.app = GitHub-only) — but never disable it when no OAuth is configured, or there'd
// be no way to sign in.
export function passwordLoginEnabled() {
  return !(process.env.AUTH_PASSWORD_DISABLED === "true" && oauthEnabled().any);
}
