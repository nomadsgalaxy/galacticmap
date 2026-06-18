// In-memory per-board live event bus (single instance). The editor publishes ephemeral board events
// — throttled drag positions and "refresh" pings — and the public SSE stream (/api/p/[secret]/stream)
// subscribes per board to relay them to spectators. Not persisted; not multi-instance (a Redis
// pub/sub would be the swap if this ever runs on more than one node).
type Sub = (data: string) => void;

// Pin the subscriber map to globalThis. Next can evaluate this module in more than one bundle context
// (route handlers vs server actions vs RSC), each getting its own module-level `const`. If the publisher
// (e.g. the acceptSuggestion server action) and the subscriber (the SSE route handler) landed on
// different instances, frames would silently never arrive — so they MUST share one map.
const g = globalThis as unknown as { __gbLiveBusSubs?: Map<string, Set<Sub>> };
const subs: Map<string, Set<Sub>> = g.__gbLiveBusSubs ?? (g.__gbLiveBusSubs = new Map());

export function publishLive(boardId: string, data: string): void {
  const set = subs.get(boardId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(data);
    } catch {
      /* drop a bad subscriber's frame */
    }
  }
}

export function subscribeLive(boardId: string, cb: Sub): () => void {
  let set = subs.get(boardId);
  if (!set) {
    set = new Set();
    subs.set(boardId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) subs.delete(boardId);
  };
}

export function hasSubscribers(boardId: string): boolean {
  return (subs.get(boardId)?.size ?? 0) > 0;
}
