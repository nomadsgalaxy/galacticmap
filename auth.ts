import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import GitLab from "next-auth/providers/gitlab";
import { z } from "zod";
import { prisma } from "@/app/lib/db";
import { verifyPassword } from "@/app/lib/passwords";

const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const isAdmin = (email?: string | null) => !!email && adminEmails.includes(email.toLowerCase());

// Pluggable providers: each OAuth provider is enabled only when its env keys are present.
const providers: NextAuthConfig["providers"] = [
  Credentials({
    credentials: { email: {}, password: {} },
    authorize: async (creds) => {
      const parsed = z
        .object({ email: z.string().email(), password: z.string().min(1) })
        .safeParse(creds);
      if (!parsed.success) return null;
      const email = parsed.data.email.toLowerCase();
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user?.passwordHash) return null;
      const ok = await verifyPassword(user.passwordHash, parsed.data.password);
      if (!ok) return null;
      return { id: user.id, email: user.email, name: user.name ?? undefined };
    },
  }),
];
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) providers.push(GitHub);
if (process.env.AUTH_GITLAB_ID && process.env.AUTH_GITLAB_SECRET) providers.push(GitLab);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    // OAuth sign-ins: ensure a User row exists and sync the admin flag from env.
    async signIn({ user, account }) {
      if (account?.provider === "credentials") return true;
      const email = user.email?.toLowerCase();
      if (!email) return false;
      const existing = await prisma.user.findUnique({ where: { email } });
      if (!existing) {
        const created = await prisma.user.create({
          data: { email, name: user.name ?? null, isInstanceAdmin: isAdmin(email) },
        });
        user.id = created.id;
      } else {
        if (existing.isInstanceAdmin !== isAdmin(email)) {
          await prisma.user.update({
            where: { id: existing.id },
            data: { isInstanceAdmin: isAdmin(email) },
          });
        }
        user.id = existing.id;
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.user.isInstanceAdmin = isAdmin(session.user.email);
      return session;
    },
  },
});
