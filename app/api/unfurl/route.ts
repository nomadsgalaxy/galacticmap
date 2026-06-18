import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/app/lib/session";

// Block obviously-internal hosts (basic SSRF guard; not exhaustive vs DNS rebinding).
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function pick(html: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

// Decode the handful of HTML entities that show up in titles/descriptions.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// Titles that mean "the site blocked/failed our fetch", not the real page — don't show these.
const JUNK_TITLE = /^(page not found|not found|404|robot check|are you a robot|bot|captcha|just a moment|attention required|access denied|sorry|error|amazon\.com|forbidden|403|please wait)\b/i;

// A clean, human label from the URL when we can't trust the fetched title.
function labelFromUrl(u: URL): string {
  const host = u.hostname.replace(/^www\./, "");
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  const slug = decodeURIComponent(last)
    .replace(/\.(html?|php|aspx?)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  // use the slug only if it reads like words (not an opaque id like an Amazon ASIN)
  if (slug && /[a-z]{3,}/i.test(slug) && slug.length <= 80 && !/^[A-Za-z0-9]{8,14}$/.test(last)) {
    return `${host} — ${slug}`;
  }
  return host;
}

export async function GET(req: NextRequest) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) return NextResponse.json({ error: "url required" }, { status: 400 });

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return NextResponse.json({ error: "unsupported protocol" }, { status: 400 });
  }
  if (isBlockedHost(url.hostname)) {
    return NextResponse.json({ error: "host not allowed" }, { status: 400 });
  }

  const favicon = `${url.origin}/favicon.ico`;
  const fallback = () =>
    NextResponse.json({ url: url.toString(), title: labelFromUrl(url), favicon });

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url.toString(), {
      // a realistic browser UA + headers — many sites serve a block/404 page to obvious bots
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(t);

    // Non-OK or non-HTML → don't trust the body; show a clean URL label instead.
    const ctype = res.headers.get("content-type") ?? "";
    if (!res.ok || !/html|xml/i.test(ctype)) return fallback();

    const html = (await res.text()).slice(0, 500_000);

    let title = pick(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']*)["']/i,
      /<title[^>]*>([^<]+)<\/title>/i,
    ]);
    title = title ? decodeEntities(title).trim() : undefined;
    // The fetch "worked" but the site returned a block/error page — that title is misleading.
    if (!title || JUNK_TITLE.test(title)) return fallback();

    let description = pick(html, [
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    ]);
    description = description ? decodeEntities(description).trim() : undefined;
    let image = pick(html, [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ]);
    if (image && image.startsWith("/")) image = new URL(image, url.origin).toString();

    return NextResponse.json({ url: url.toString(), title, description, image, favicon });
  } catch {
    return fallback();
  }
}
