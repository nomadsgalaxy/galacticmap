"use client";

import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";

// Real-time collaboration (P7). Entirely gated on NEXT_PUBLIC_COLLAB_URL: when unset, this hook
// is inert and the editor is exactly the single-user experience. yjs/y-websocket are loaded
// DYNAMICALLY inside the effect (only when collab is enabled) so they never ship in the
// collab-off editor bundle.

export type Peer = {
  clientId: number;
  name: string;
  color: string;
  cursor?: { x: number; y: number } | null;
};

export type CollabHandle = {
  doc: Y.Doc;
  provider: WebsocketProvider;
  awareness: WebsocketProvider["awareness"];
  yNodes: Y.Map<Record<string, unknown>>;
  yEdges: Y.Map<Record<string, unknown>>;
  myColor: string;
  setCursor: (pos: { x: number; y: number } | null) => void;
};

const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

export function collabEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_COLLAB_URL;
}

export function useCollab(boardId: string, enabled: boolean, me: { name: string }) {
  const [handle, setHandle] = useState<CollabHandle | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_COLLAB_URL;
    if (!enabled || !url) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const [Y, { WebsocketProvider }] = await Promise.all([import("yjs"), import("y-websocket")]);
      if (cancelled) return;

      const doc = new Y.Doc();
      const provider = new WebsocketProvider(url, boardId, doc);
      const yNodes = doc.getMap<Record<string, unknown>>("nodes");
      const yEdges = doc.getMap<Record<string, unknown>>("edges");
      const myColor = COLORS[doc.clientID % COLORS.length];
      provider.awareness.setLocalStateField("user", { name: me.name || "Guest", color: myColor });

      const setCursor = (pos: { x: number; y: number } | null) =>
        provider.awareness.setLocalStateField("cursor", pos);

      const onStatus = (e: { status: string }) => setConnected(e.status === "connected");
      provider.on("status", onStatus);

      const onAware = () => {
        const out: Peer[] = [];
        provider.awareness.getStates().forEach((s, id) => {
          if (id === provider.awareness.clientID) return;
          const u = (s as { user?: { name: string; color: string } }).user;
          if (u) out.push({ clientId: id, name: u.name, color: u.color, cursor: (s as { cursor?: { x: number; y: number } | null }).cursor });
        });
        setPeers(out);
      };
      provider.awareness.on("change", onAware);

      setHandle({ doc, provider, awareness: provider.awareness, yNodes, yEdges, myColor, setCursor });

      cleanup = () => {
        provider.awareness.off("change", onAware);
        provider.off("status", onStatus);
        provider.destroy();
        doc.destroy();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
      setHandle(null);
      setPeers([]);
      setConnected(false);
    };
  }, [enabled, boardId, me.name]);

  return { handle, peers, connected };
}
