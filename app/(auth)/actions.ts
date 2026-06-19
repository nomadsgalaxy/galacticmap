"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { hash } from "@node-rs/argon2";
import { signIn } from "@/auth";
import { prisma } from "@/app/lib/db";
import { passwordLoginEnabled } from "@/app/lib/auth-config";

export type AuthFormState = { error?: string } | undefined;

function safeCallback(raw: unknown): string {
  const s = String(raw ?? "/");
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

// Start an OAuth sign-in (GitHub/GitLab). signIn() throws NEXT_REDIRECT to the provider on success, so
// we don't catch it. Provider is allowlisted so the form field can't request an arbitrary provider.
export async function oauthSignIn(formData: FormData): Promise<void> {
  const provider = String(formData.get("provider") ?? "");
  if (provider !== "github" && provider !== "gitlab") return;
  await signIn(provider, { redirectTo: safeCallback(formData.get("callbackUrl")) });
}

export async function loginAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const redirectTo = safeCallback(formData.get("callbackUrl"));
  try {
    await signIn("credentials", { email, password, redirectTo });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Invalid email or password." };
    throw error; // re-throw NEXT_REDIRECT (the success path)
  }
  return undefined;
}

export async function signupAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  if (!passwordLoginEnabled()) return { error: "Password sign-up is disabled on this instance." };
  const parsed = z
    .object({
      email: z.string().email(),
      password: z.string().min(8, "Password must be at least 8 characters."),
      name: z.string().max(80).optional(),
    })
    .safeParse({
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      name: String(formData.get("name") ?? "") || undefined,
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const email = parsed.data.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { error: "That email is already registered." };

  const passwordHash = await hash(parsed.data.password);
  await prisma.user.create({ data: { email, name: parsed.data.name ?? null, passwordHash } });

  try {
    await signIn("credentials", { email, password: parsed.data.password, redirectTo: "/" });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Account created — please log in." };
    throw error;
  }
  return undefined;
}
