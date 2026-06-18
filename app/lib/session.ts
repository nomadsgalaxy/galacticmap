import { redirect } from "next/navigation";
import { auth } from "@/auth";
import type { Principal } from "@/app/lib/authz";

/** Current principal (or null). Reads the session — dynamic; call inside <Suspense> in RSC. */
export async function getPrincipal(): Promise<Principal> {
  const session = await auth();
  return session?.user?.id ? { userId: session.user.id } : null;
}

/** Require a signed-in user, else redirect to /login. */
export async function requireUserId(): Promise<string> {
  const principal = await getPrincipal();
  if (!principal) redirect("/login");
  return principal.userId;
}
