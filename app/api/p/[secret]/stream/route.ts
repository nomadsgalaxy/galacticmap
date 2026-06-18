import { prisma } from "@/app/lib/db";
import { subscribeLive } from "@/app/lib/live-bus";

// Server-Sent Events stream for a published share: relays the owner's live board events (drag
// positions + refresh pings) to public spectators so the shared view tracks edits in real time.
export async function GET(req: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const share = await prisma.publicShare.findUnique({ where: { secret }, select: { isPublished: true, boardId: true } });
  if (!share || !share.isPublished) return new Response("Not found", { status: 404 });
  const boardId = share.boardId;

  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  // SECURITY: still a hard whitelist (defense-in-depth) — the relay forwards only frame types known to
  // be public-safe and NEVER tokens/ipHash/hidden notes. "sug" carries the proposal payload, but that
  // payload is sanitized at write (sanitizePublicNodeData: public types only, notes/credit stripped),
  // so showing everyone's suggestions live is safe. "sug-vote"/"sug-resolved" carry ids + counts only.
  const PUBLIC_FRAMES = new Set(["hello", "pos", "refresh", "sug", "sug-resolved", "sug-vote"]);

  const stream = new ReadableStream({
    start(controller) {
      const emit = (data: string) => {
        try {
          controller.enqueue(enc.encode(`data: ${data}\n\n`));
        } catch {
          /* stream closed */
        }
      };
      // Bus subscriber: parse + whitelist before relaying to anonymous spectators.
      const relay = (data: string) => {
        let type: unknown;
        try {
          type = (JSON.parse(data) as { type?: unknown }).type;
        } catch {
          return; // unparseable → never forward
        }
        if (typeof type === "string" && PUBLIC_FRAMES.has(type)) emit(data);
      };
      emit(JSON.stringify({ type: "hello" }));
      unsub = subscribeLive(boardId, relay);
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n")); // keep-alive comment
        } catch {
          /* closed */
        }
      }, 25000);
      req.signal.addEventListener("abort", () => {
        if (ping) clearInterval(ping);
        unsub?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (ping) clearInterval(ping);
      unsub?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
