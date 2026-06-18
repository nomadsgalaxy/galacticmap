import { getPrincipal } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { subscribeLive } from "@/app/lib/live-bus";

// Authenticated editor SSE: relays live public-suggestion frames ("sug" = ghost upsert/remove, with the
// public-safe payload; "sug-resolved" = a moderator accepted/discarded items) to the owner's board so
// suggestions appear/disappear in real time as hazy ghosts. Editors only — gated on suggestion:accept.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getPrincipal();
  if (!principal) return new Response("unauthorized", { status: 401 });
  try {
    await assertCan(principal, id, "suggestion:accept");
  } catch {
    return new Response("forbidden", { status: 403 });
  }

  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const EDITOR_FRAMES = new Set(["sug", "sug-resolved", "sug-vote"]);

  const stream = new ReadableStream({
    start(controller) {
      const emit = (data: string) => {
        try {
          controller.enqueue(enc.encode(`data: ${data}\n\n`));
        } catch {
          /* closed */
        }
      };
      const relay = (data: string) => {
        let type: unknown;
        try {
          type = (JSON.parse(data) as { type?: unknown }).type;
        } catch {
          return;
        }
        if (typeof type === "string" && EDITOR_FRAMES.has(type)) emit(data);
      };
      emit(JSON.stringify({ type: "hello" }));
      unsub = subscribeLive(id, relay);
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
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
