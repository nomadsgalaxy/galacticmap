import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/app/lib/db";
import { rateLimiter } from "@/app/lib/ratelimit";
import { ipHash } from "@/app/lib/net";

// RESTRICTED public surface (plan.md §7): only read the published snapshot + append a suggestion.
// Never expose canonical write methods here. Guests/anonymous code paths import ONLY this module,
// never the full prisma client for the canonical graph.

export type ShareSnapshot = {
  boardTitle: string;
  suggestionsOpen: boolean;
  nodes: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    width: number | null;
    height: number | null;
    zIndex: number;
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    animated: boolean;
    label: string | null;
    data: Record<string, unknown>;
  }>;
  // Cloud groups (the colored region behind a set of nodes). Only members that survive the public
  // projection are kept; empty groups are dropped.
  groups: Array<{ id: string; label: string | null; color: string | null; tags: string[]; nodeIds: string[] }>;
};

// Node types a guest may SUGGEST (text/swatch/link). Images aren't suggestable (no upload path).
const PUBLIC_TYPES = new Set(["text", "swatch", "link"]);
// Node types shown on the published board. Images ARE shown; their asset bytes are served anonymously
// by /api/assets/[id] only when the asset is referenced by an image node on a published board.
const PUBLIC_VIEW_TYPES = new Set(["text", "swatch", "link", "image", "spreadsheet", "tracker"]);
type NodeRow = { id: string; type: string; posX: number | null; posY: number | null; width: number | null; height: number | null; zIndex: number; data: unknown };
type EdgeRow = { id: string; sourceId: string; targetId: string; type: string; animated: boolean; label: string | null; data: unknown };
type GroupRow = { id: string; label: string | null; color: string | null; tags: unknown; nodeIds: unknown };

// The ONLY shape ever sent to anonymous viewers: text/swatch/link nodes with hidden notes stripped,
// plus connectors between surviving nodes. Single-sourced here so the privacy rules can't drift.
export function projectPublicGraph(nodes: NodeRow[], edges: EdgeRow[], groups: GroupRow[] = []): Pick<ShareSnapshot, "nodes" | "edges" | "groups"> {
  const pubNodes = nodes
    .filter((n) => PUBLIC_VIEW_TYPES.has(n.type))
    .map((n) => {
      const data = { ...((n.data as Record<string, unknown>) ?? {}) };
      delete data.notes; // never publish hidden notes
      return { id: n.id, type: n.type, x: n.posX ?? 0, y: n.posY ?? 0, width: n.width, height: n.height, zIndex: n.zIndex ?? 0, data };
    });
  const ids = new Set(pubNodes.map((n) => n.id));
  const pubEdges = edges
    .filter((e) => ids.has(e.sourceId) && ids.has(e.targetId))
    .map((e) => ({ id: e.id, source: e.sourceId, target: e.targetId, type: e.type, animated: e.animated, label: e.label, data: (e.data as Record<string, unknown>) ?? {} }));
  // Keep only group members that survived the projection; drop groups left with no visible members.
  const pubGroups = groups
    .map((g) => ({
      id: g.id,
      label: g.label,
      color: g.color,
      tags: Array.isArray(g.tags) ? (g.tags as string[]) : [],
      nodeIds: (Array.isArray(g.nodeIds) ? (g.nodeIds as string[]) : []).filter((nid) => ids.has(nid)),
    }))
    .filter((g) => g.nodeIds.length > 0);
  return { nodes: pubNodes, edges: pubEdges, groups: pubGroups };
}

// LIVE public view: the board's CURRENT public-safe graph, recomputed each call so a published board
// mirrors the owner's edits in real time (the public canvas polls this).
export async function getLiveShare(secret: string): Promise<ShareSnapshot | null> {
  const s = await prisma.publicShare.findUnique({
    where: { secret },
    select: {
      isPublished: true,
      suggestionsOpen: true,
      board: {
        select: {
          title: true,
          nodes: { select: { id: true, type: true, posX: true, posY: true, width: true, height: true, zIndex: true, data: true } },
          edges: { select: { id: true, sourceId: true, targetId: true, type: true, animated: true, label: true, data: true } },
          groups: { select: { id: true, label: true, color: true, tags: true, nodeIds: true } },
        },
      },
    },
  });
  if (!s || !s.isPublished) return null;
  const { nodes, edges, groups } = projectPublicGraph(s.board.nodes, s.board.edges, s.board.groups);
  return { boardTitle: s.board.title, suggestionsOpen: s.suggestionsOpen, nodes, edges, groups };
}

type SubmitResult =
  | { ok: true }
  | { ok: false; status: number; error: string; retryAfter?: number };

// A guest-proposed graph diff (additions only): new nodes (with client tempIds) + new connectors
// whose endpoints reference a tempId or an existing board node id. Inert JSON — no FK into the graph.
export type ProposalNode = { tempId: string; type: string; x: number; y: number; width?: number | null; height?: number | null; data: Record<string, unknown> };
export type ProposalEdge = { source: string; target: string; data?: Record<string, unknown> };
export type Proposal = { nodes: ProposalNode[]; edges: ProposalEdge[] };

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// HARD allowlist sanitizer: a stored suggestion payload is echoed LIVE to the editor as a ghost
// (and could be relayed further), so it must be public-safe by construction — pick ONLY the known
// fields per type, drop hidden notes, and DROP any client-supplied credit (credit is server-stamped
// at accept time only). Anything not listed here is discarded. parseNodeData re-validates at accept.
function sanitizePublicNodeData(type: string, raw: unknown): Record<string, unknown> {
  const d = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  // Per-node variable template + on-node visibility flag. Public-safe for EVERY type: varText is just a
  // bounded string and showVars a boolean, so guest-suggested per-node vars survive the allowlist and
  // their on-node labels render publicly. Applied as a shared tail to each per-type return.
  const withVars = (out: Record<string, unknown>): Record<string, unknown> => {
    if (typeof d.varText === "string") out.varText = d.varText.slice(0, 500);
    if (typeof d.showVars === "boolean") out.showVars = d.showVars;
    return out;
  };
  if (type === "swatch") {
    const hex = typeof d.hex === "string" && /^#[0-9a-fA-F]{6}$/.test(d.hex) ? d.hex : "#6d28d9";
    return withVars({ hex });
  }
  if (type === "link") {
    const url = typeof d.url === "string" ? d.url.slice(0, 2000) : "";
    const out: Record<string, unknown> = { url };
    if (typeof d.title === "string") out.title = d.title.slice(0, 300);
    return withVars(out);
  }
  if (type === "spreadsheet") {
    const rows = Math.max(1, Math.min(50, Number(d.rows) || 4));
    const cols = Math.max(1, Math.min(26, Number(d.cols) || 4));
    const cells: Record<string, string> = {};
    const raw = d.cells && typeof d.cells === "object" ? (d.cells as Record<string, unknown>) : {};
    let n = 0;
    for (const k of Object.keys(raw)) {
      if (n++ >= 1300) break; // ≤ 50×26 cells
      if (/^[A-Z]+\d+$/.test(k) && typeof raw[k] === "string") cells[k] = (raw[k] as string).slice(0, 500);
    }
    return withVars({ rows, cols, cells });
  }
  if (type === "tracker") {
    const out: Record<string, unknown> = {};
    if (typeof d.title === "string") out.title = d.title.slice(0, 200);
    const lines: string[] = [];
    if (Array.isArray(d.lines)) {
      for (const line of d.lines) {
        if (lines.length >= 50) break; // ≤ 50 lines
        if (typeof line === "string") lines.push(line.slice(0, 200)); // each ≤ 200 chars
      }
    }
    out.lines = lines;
    return withVars(out);
  }
  // text (default)
  return withVars({ text: typeof d.text === "string" ? d.text.slice(0, 5000) : "" });
}

// Validate + normalize a guest proposal before storing. Accept-time parseNodeData is the strict gate;
// this bounds size/shape AND sanitizes each node's data to the public allowlist so what we persist is
// safe to echo live. Returns null if unusable. `allowEmpty` lets the live-upsert path send 0 nodes
// (meaning "I cleared my suggestion") without it being treated as junk.
function normalizeProposal(raw: unknown, opts?: { allowEmpty?: boolean }): Proposal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(r.nodes)) return null;
  if (r.nodes.length === 0 && !opts?.allowEmpty) return null;
  if (r.nodes.length > 40) return null;
  if (r.edges != null && (!Array.isArray(r.edges) || r.edges.length > 80)) return null;

  const nodes: ProposalNode[] = [];
  for (const n of r.nodes as Record<string, unknown>[]) {
    const type = String(n.type ?? "");
    if (!PUBLIC_TYPES.has(type)) return null; // text/swatch/link only
    const tempId = String(n.tempId ?? "").slice(0, 60);
    if (!tempId) return null;
    nodes.push({
      tempId,
      type,
      x: num(n.x),
      y: num(n.y),
      width: typeof n.width === "number" ? n.width : null,
      height: typeof n.height === "number" ? n.height : null,
      data: sanitizePublicNodeData(type, n.data),
    });
  }
  const edges: ProposalEdge[] = [];
  for (const e of (Array.isArray(r.edges) ? r.edges : []) as Record<string, unknown>[]) {
    const source = String(e.source ?? "").slice(0, 60);
    const target = String(e.target ?? "").slice(0, 60);
    if (!source || !target) continue;
    edges.push({ source, target, data: {} }); // edge data is never client-trusted
  }
  // bound total size (defensive)
  if (JSON.stringify({ nodes, edges }).length > 60_000) return null;
  return { nodes, edges };
}

/** Append-only suggestion intake. Reject-before-DB rate limit; no FK into the canonical graph. */
export async function submitSuggestion(
  secret: string,
  input: { authorName?: string; proposal: unknown },
  ip: string,
  userAgent?: string,
): Promise<SubmitResult> {
  const share = await prisma.publicShare.findUnique({
    where: { secret },
    select: {
      id: true,
      isPublished: true,
      suggestionsOpen: true,
      cooldownSeconds: true,
      burstAllowance: true,
      maxSuggestions: true,
    },
  });
  if (!share || !share.isPublished) return { ok: false, status: 404, error: "Not found" };
  if (!share.suggestionsOpen) return { ok: false, status: 403, error: "Suggestions are closed" };

  const proposal = normalizeProposal(input.proposal);
  if (!proposal) return { ok: false, status: 422, error: "Add 1–40 items (text, swatches or links) to suggest." };

  const hash = ipHash(ip);
  const rate = 1 / Math.max(share.cooldownSeconds, 1);
  const { allowed, retryAfter } = rateLimiter.check(`sg:${share.id}:${hash}`, rate, Math.max(1, share.burstAllowance));
  if (!allowed) return { ok: false, status: 429, error: `Slow down — try again in ${retryAfter}s`, retryAfter };

  // Global per-share ceiling (cheap count; the in-memory limiter already shed the flood).
  const pending = await prisma.suggestion.count({ where: { shareId: share.id, status: "PENDING" } });
  if (pending >= share.maxSuggestions) {
    return { ok: false, status: 429, error: "This board isn't accepting more suggestions right now" };
  }

  await prisma.suggestion.create({
    data: {
      shareId: share.id,
      status: "PENDING",
      payloadVersion: 2,
      authorName: input.authorName?.trim().slice(0, 60) || null,
      payload: proposal as unknown as Prisma.InputJsonValue,
      ipHash: hash,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
  });
  return { ok: true };
}

// ── Public visibility of everyone's suggestions + per-item voting ─────────────────────────────────
export type VoteTally = Record<string, { up: number; down: number }>; // keyed by item tempId
export type PublicSuggestion = {
  id: string;
  authorName: string | null;
  nodes: ProposalNode[];
  edges: ProposalEdge[];
  votes: VoteTally;
};

// Every PENDING suggestion on a published share, projected public-safe (re-sanitized defensively) with
// per-item vote tallies. Drives the "see everyone's suggestions" layer on the public board + the owner's
// prioritisation. Returns [] for an unpublished/missing share.
export async function getPublicSuggestions(secret: string): Promise<PublicSuggestion[]> {
  const share = await prisma.publicShare.findUnique({ where: { secret }, select: { id: true, isPublished: true } });
  if (!share || !share.isPublished) return [];
  const rows = await prisma.suggestion.findMany({
    where: { shareId: share.id, status: "PENDING" },
    select: { id: true, authorName: true, payload: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  if (rows.length === 0) return [];
  const tallies = await tallyVotes(rows.map((r) => r.id));
  return rows.map((r) => {
    const p = (r.payload as { nodes?: ProposalNode[]; edges?: ProposalEdge[] }) ?? {};
    // Defensive re-projection: even a legacy/under-sanitized row can only ever surface public data.
    const nodes = (p.nodes ?? [])
      .filter((n) => PUBLIC_TYPES.has(String(n.type)))
      .map((n) => ({ ...n, data: sanitizePublicNodeData(String(n.type), n.data) }));
    return { id: r.id, authorName: r.authorName, nodes, edges: p.edges ?? [], votes: tallies.get(r.id) ?? {} };
  });
}

async function tallyVotes(suggestionIds: string[]): Promise<Map<string, VoteTally>> {
  const out = new Map<string, VoteTally>();
  if (suggestionIds.length === 0) return out;
  const grouped = await prisma.suggestionVote.groupBy({
    by: ["suggestionId", "tempId", "value"],
    where: { suggestionId: { in: suggestionIds } },
    _count: { _all: true },
  });
  for (const g of grouped) {
    const m = out.get(g.suggestionId) ?? {};
    const cell = m[g.tempId] ?? { up: 0, down: 0 };
    if (g.value > 0) cell.up = g._count._all;
    else cell.down = g._count._all;
    m[g.tempId] = cell;
    out.set(g.suggestionId, m);
  }
  return out;
}

type VoteResult =
  | { ok: true; boardId: string; suggestionId: string; tempId: string; up: number; down: number; my: number }
  | { ok: false; status: number; error: string; retryAfter?: number };

// One up/down vote per voter (hashed token) per suggestion item. value > 0 up, < 0 down, 0 clears.
export async function voteSuggestion(
  secret: string,
  authorToken: string,
  suggestionId: string,
  tempId: string,
  value: number,
  ip: string,
): Promise<VoteResult> {
  if (typeof authorToken !== "string" || authorToken.length < 8) return { ok: false, status: 400, error: "bad token" };
  const share = await prisma.publicShare.findUnique({ where: { secret }, select: { id: true, boardId: true, isPublished: true, suggestionsOpen: true } });
  if (!share || !share.isPublished) return { ok: false, status: 404, error: "Not found" };
  if (!share.suggestionsOpen) return { ok: false, status: 403, error: "Suggestions are closed" };
  // The item must be a real pending suggestion item on THIS share (IDOR guard).
  const sug = await prisma.suggestion.findFirst({ where: { id: suggestionId, shareId: share.id, status: "PENDING" }, select: { payload: true } });
  if (!sug) return { ok: false, status: 404, error: "Not found" };
  const nodes = (((sug.payload as { nodes?: { tempId?: string }[] })?.nodes) ?? []);
  if (!nodes.some((n) => String(n.tempId) === tempId)) return { ok: false, status: 404, error: "Item not found" };

  const hash = ipHash(ip);
  const vb = rateLimiter.check(`sgvote:${share.id}:${hash}`, 4, 12);
  if (!vb.allowed) return { ok: false, status: 429, error: `Slow down — ${vb.retryAfter}s`, retryAfter: vb.retryAfter };

  const voterHash = hashToken(authorToken);
  const my = value > 0 ? 1 : value < 0 ? -1 : 0;
  if (my === 0) {
    await prisma.suggestionVote.deleteMany({ where: { suggestionId, tempId, voterHash } });
  } else {
    await prisma.suggestionVote.upsert({
      where: { suggestionId_tempId_voterHash: { suggestionId, tempId, voterHash } },
      create: { suggestionId, tempId, voterHash, value: my },
      update: { value: my },
    });
  }
  const [up, down] = await Promise.all([
    prisma.suggestionVote.count({ where: { suggestionId, tempId, value: 1 } }),
    prisma.suggestionVote.count({ where: { suggestionId, tempId, value: -1 } }),
  ]);
  return { ok: true, boardId: share.boardId, suggestionId, tempId, up, down, my };
}

// ── Live suggestions (no "Submit") ───────────────────────────────────────────────────────────────
// A public author's whole working sub-graph is ONE PENDING Suggestion row, upserted live as they add /
// move / edit. Author-only via an opaque client token (hashed into authorTokenHash). The payload stays
// inert (no FK). Concurrency: payloadRev optimistic lock. Result carries boardId + the (already
// public-safe) ghost data so the route can fan it out to the editor over the live bus.
export type UpsertResult =
  | { ok: true; boardId: string; op: "upsert"; suggestion: { id: string; authorName: string | null; payload: Proposal } }
  | { ok: true; boardId: string; op: "remove"; suggestionId: string }
  | { ok: true; boardId: string; op: "noop" }
  | { ok: false; status: number; error: string; retryAfter?: number };

export async function upsertSuggestion(
  secret: string,
  authorToken: string,
  input: { authorName?: string; proposal: unknown },
  ip: string,
  userAgent?: string,
): Promise<UpsertResult> {
  if (typeof authorToken !== "string" || authorToken.length < 8 || authorToken.length > 200) {
    return { ok: false, status: 400, error: "bad token" };
  }
  // Re-check publish/open state on EVERY mutation (not just create) so closing/unpublishing a board
  // immediately stops live edits, not only new submissions.
  const share = await prisma.publicShare.findUnique({
    where: { secret },
    select: { id: true, boardId: true, isPublished: true, suggestionsOpen: true, cooldownSeconds: true, burstAllowance: true, maxSuggestions: true },
  });
  if (!share || !share.isPublished) return { ok: false, status: 404, error: "Not found" };
  if (!share.suggestionsOpen) return { ok: false, status: 403, error: "Suggestions are closed" };

  const proposal = normalizeProposal(input.proposal, { allowEmpty: true });
  if (!proposal) return { ok: false, status: 422, error: "Invalid suggestion" };

  const hash = ipHash(ip);
  const tokenHash = hashToken(authorToken);
  const name = input.authorName?.trim().slice(0, 60) || null;
  const existing = await prisma.suggestion.findFirst({
    where: { shareId: share.id, status: "PENDING", authorTokenHash: tokenHash },
    select: { id: true, payloadRev: true, authorName: true },
  });

  // Cleared everything → drop the author's row (if any).
  if (proposal.nodes.length === 0) {
    if (!existing) return { ok: true, boardId: share.boardId, op: "noop" };
    await prisma.suggestion.deleteMany({ where: { id: existing.id, status: "PENDING" } });
    return { ok: true, boardId: share.boardId, op: "remove", suggestionId: existing.id };
  }

  if (existing) {
    // Looser bucket for live move/edit so dragging feels fluid; client also debounces.
    const mv = rateLimiter.check(`sgmv:${share.id}:${hash}`, 8, 16);
    if (!mv.allowed) return { ok: false, status: 429, error: `Slow down — ${mv.retryAfter}s`, retryAfter: mv.retryAfter };
    let rev = existing.payloadRev;
    for (let attempt = 0; attempt < 2; attempt++) {
      const upd = await prisma.suggestion.updateMany({
        where: { id: existing.id, status: "PENDING", payloadRev: rev },
        data: { payload: proposal as unknown as Prisma.InputJsonValue, payloadRev: rev + 1, authorName: name ?? existing.authorName },
      });
      if (upd.count > 0) {
        return { ok: true, boardId: share.boardId, op: "upsert", suggestion: { id: existing.id, authorName: name ?? existing.authorName, payload: proposal } };
      }
      const fresh = await prisma.suggestion.findFirst({ where: { id: existing.id, status: "PENDING" }, select: { payloadRev: true } });
      if (!fresh) break; // accepted/discarded under us
      rev = fresh.payloadRev;
    }
    return { ok: true, boardId: share.boardId, op: "noop" }; // lost the race; harmless (positions are low-stakes)
  }

  // New author session → strict create bucket + per-share + per-IP ceilings.
  const rate = 1 / Math.max(share.cooldownSeconds, 1);
  const cr = rateLimiter.check(`sg:${share.id}:${hash}`, rate, Math.max(1, share.burstAllowance));
  if (!cr.allowed) return { ok: false, status: 429, error: `Slow down — ${cr.retryAfter}s`, retryAfter: cr.retryAfter };
  const [pendingShare, pendingIp] = await Promise.all([
    prisma.suggestion.count({ where: { shareId: share.id, status: "PENDING" } }),
    prisma.suggestion.count({ where: { shareId: share.id, status: "PENDING", ipHash: hash } }),
  ]);
  if (pendingShare >= share.maxSuggestions) return { ok: false, status: 429, error: "This board isn't accepting more suggestions right now" };
  if (pendingIp >= 5) return { ok: false, status: 429, error: "You already have several pending suggestions — let a moderator review them first." };

  const created = await prisma.suggestion.create({
    data: {
      shareId: share.id,
      status: "PENDING",
      payloadVersion: 2,
      authorName: name,
      authorTokenHash: tokenHash,
      payload: proposal as unknown as Prisma.InputJsonValue,
      ipHash: hash,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
    select: { id: true },
  });
  return { ok: true, boardId: share.boardId, op: "upsert", suggestion: { id: created.id, authorName: name, payload: proposal } };
}
