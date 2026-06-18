import { createHash } from "node:crypto";

// Real client IP, honoring a configured number of trusted reverse-proxy hops.
// X-Forwarded-For is client-spoofable on the left, so we take the rightmost-from-trusted-hop.
export function getClientIp(req: Request): string {
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "0", 10) || 0;
  const xff = req.headers.get("x-forwarded-for");
  if (hops > 0 && xff) {
    const ips = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const idx = ips.length - hops;
    if (idx >= 0 && ips[idx]) return ips[idx];
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

// Hash for abuse correlation (NOT anonymizing — the IPv4 space is small).
export function ipHash(ip: string): string {
  const salt = process.env.SUGGESTION_IP_SALT ?? process.env.AUTH_SECRET ?? "gb-dev-salt";
  return createHash("sha256").update(ip + salt).digest("hex").slice(0, 32);
}
