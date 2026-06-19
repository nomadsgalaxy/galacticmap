import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy · Galactic Map",
  description: "What Galactic Map collects, and what it doesn't.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16 pb-24 text-on-surface">
      <Link href="/" className="text-sm text-primary hover:underline">
        ← Galactic Map
      </Link>

      <h1 className="mt-6 text-3xl font-bold tracking-tight text-on-background">Privacy Policy</h1>
      <p className="mt-1 text-sm text-on-surface-variant">Last updated: June 19, 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-on-surface-variant [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-on-surface [&_a]:text-primary [&_a]:hover:underline">
        <p>
          This covers <strong>chart.galacticmap.app</strong>, the instance of Galactic Map run by
          NomadsGalaxy. Galactic Map is open source, so other people host their own copies; if you&apos;re
          on one of those, its operator handles your data, not us.
        </p>

        <p>
          The short version: we don&apos;t sell your data, we don&apos;t hand it to anyone for advertising
          or analytics, and we don&apos;t poke around in your boards. The only time we&apos;d look at your
          content is to reproduce and fix a bug you&apos;ve reported.
        </p>

        <h2>What we collect</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Account.</strong> When you sign in with GitHub we receive your email address and
            display name. That&apos;s how you log in and how your boards are tied to you.
          </li>
          <li>
            <strong>Your content.</strong> The boards, notes, images, and other things you create. We store
            them so we can show them back to you and to anyone you share a board with.
          </li>
          <li>
            <strong>Basic technical logs.</strong> Standard request logs (like IP address and browser type)
            from our server and Cloudflare, kept to keep the service running and to stop abuse.
          </li>
        </ul>

        <h2>What we don&apos;t do</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>We never sell your data.</li>
          <li>We don&apos;t share it with third parties for marketing, advertising, or analytics.</li>
          <li>We don&apos;t read your boards except when you ask for help or file a bug, and only to fix it.</li>
          <li>There are no ad trackers or third-party analytics scripts.</li>
        </ul>

        <h2>Public boards</h2>
        <p>
          If you publish a board, anyone with the link can view it. So don&apos;t put anything private in a
          board you&apos;ve published. You can unpublish it at any time from the board&apos;s Share page.
        </p>

        <h2>Who else is involved</h2>
        <p>
          Two services make this work: <strong>GitHub</strong> (sign-in) and <strong>Cloudflare</strong>
          {" "}(delivers the site and filters abuse). They each have their own privacy policies. We don&apos;t
          use anyone else.
        </p>

        <h2>Cookies</h2>
        <p>
          One cookie keeps you signed in. A few preferences (like your theme) live in your browser&apos;s
          local storage and never leave your device. No tracking cookies.
        </p>

        <h2>Keeping and deleting your data</h2>
        <p>
          Your data stays until you remove it. You can export any board to a file from the board menu. To
          delete your account and everything in it, email us and we&apos;ll take care of it.
        </p>

        <h2>Changes</h2>
        <p>If this policy changes, we&apos;ll update the date at the top.</p>

        <h2>Contact</h2>
        <p>
          Questions, or want your data removed? Email{" "}
          <a href="mailto:privacy@nomadsgalaxy.com">privacy@nomadsgalaxy.com</a>.
        </p>
      </div>
    </main>
  );
}
