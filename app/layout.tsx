import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./_components/ThemeProvider";
import { ThemeForge } from "./_components/ThemeForge";
import { ReportBug } from "./_components/ReportBug";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Galactic Map",
  description: "Self-hostable hybrid moodboard + mind-map.",
  icons: { icon: "/logo.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // mobile browser chrome matches the app surface (light/dark)
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fffbff" },
    { media: "(prefers-color-scheme: dark)", color: "#1d1b1e" },
  ],
};

// Set the light/dark variant before paint to avoid a flash (FOUC).
const noFlashScript = `(function(){try{var t=JSON.parse(localStorage.getItem('gb:theme')||'null');var v=t&&t.variant;if(!v||v==='system'){v=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme-variant',v);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          {children}
          <ThemeForge />
          {/* Site-wide attribution (also satisfies the license's SWAtt creator-identification term).
              pointer-events-none on the bar so it never blocks the canvas; only the links are clickable. */}
          <footer className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center p-1 text-[10px] leading-none">
            <span className="pointer-events-auto rounded-full bg-surface-container/80 px-2 py-0.5 text-on-surface-variant shadow-elev-1 backdrop-blur">
              <a
                href="https://github.com/nomadsgalaxy/galacticmap"
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-on-surface hover:underline"
              >
                Galactic Map
              </a>
              {" by "}
              <a
                href="https://www.nomadsgalaxy.com"
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-on-surface hover:underline"
              >
                NomadsGalaxy
              </a>
              <span className="mx-1.5 text-outline-variant" aria-hidden="true">·</span>
              <ReportBug />
              <span className="mx-1.5 text-outline-variant" aria-hidden="true">·</span>
              <a href="/privacy" className="font-medium text-on-surface hover:underline">
                Privacy
              </a>
            </span>
          </footer>
        </ThemeProvider>
      </body>
    </html>
  );
}
