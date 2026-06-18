#!/usr/bin/env node
// GalacticBoard real-time collaboration server (P7).
//
// A self-hostable Yjs WebSocket relay (the y-websocket wire protocol) speaking sync + awareness.
// One Y.Doc + Awareness per room (room = board id). Pure in-memory relay: the canonical board
// still persists to the DB via the app's normal actions; this server only fans out live edits +
// presence between connected editors. Run it next to the app and point NEXT_PUBLIC_COLLAB_URL at it.
//
// Run:  COLLAB_PORT=1234 node collab-server/index.mjs
//
// It is OFF by default: if the app has no NEXT_PUBLIC_COLLAB_URL, the editor is fully single-user.

import http from "node:http";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const PORT = Number(process.env.COLLAB_PORT || 1234);
const PING_TIMEOUT = 30000;
const messageSync = 0;
const messageAwareness = 1;

/** roomName -> shared doc state */
const docs = new Map();

class WSDoc extends Y.Doc {
  constructor(name) {
    super({ gc: true });
    this.name = name;
    /** ws -> Set<awareness clientID> */
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      if (origin && this.conns.has(origin)) {
        const ids = this.conns.get(origin);
        added.forEach((id) => ids.add(id));
        removed.forEach((id) => ids.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageAwareness);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const buf = encoding.toUint8Array(enc);
      this.conns.forEach((_, conn) => send(this, conn, buf));
    });

    this.on("update", (update) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageSync);
      syncProtocol.writeUpdate(enc, update);
      const buf = encoding.toUint8Array(enc);
      this.conns.forEach((_, conn) => send(this, conn, buf));
    });
  }
}

function getDoc(name) {
  let d = docs.get(name);
  if (!d) {
    d = new WSDoc(name);
    docs.set(name, d);
  }
  return d;
}

function send(doc, conn, buf) {
  if (conn.readyState !== conn.CONNECTING && conn.readyState !== conn.OPEN) {
    closeConn(doc, conn);
    return;
  }
  try {
    conn.send(buf, (err) => err && closeConn(doc, conn));
  } catch {
    closeConn(doc, conn);
  }
}

function closeConn(doc, conn) {
  if (doc.conns.has(conn)) {
    const ids = doc.conns.get(conn);
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, [...ids], null);
    if (doc.conns.size === 0) {
      // last editor left — drop the in-memory doc (DB holds the canonical copy)
      doc.destroy();
      docs.delete(doc.name);
    }
  }
  try {
    conn.close();
  } catch {
    /* already closed */
  }
}

function onMessage(conn, doc, message) {
  const decoder = decoding.createDecoder(message);
  const encoder = encoding.createEncoder();
  const type = decoding.readVarUint(decoder);
  switch (type) {
    case messageSync:
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
      if (encoding.length(encoder) > 1) send(doc, conn, encoding.toUint8Array(encoder));
      break;
    case messageAwareness:
      awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn);
      break;
  }
}

const wss = new WebSocketServer({ noServer: true });
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("GalacticBoard collab server\n");
});

wss.on("connection", (conn, req) => {
  conn.binaryType = "arraybuffer";
  const room = (req.url || "/").slice(1).split("?")[0] || "default";
  const doc = getDoc(room);
  doc.conns.set(conn, new Set());

  conn.on("message", (msg) => onMessage(conn, doc, new Uint8Array(msg)));

  let alive = true;
  conn.on("pong", () => (alive = true));
  const interval = setInterval(() => {
    if (!doc.conns.has(conn)) {
      clearInterval(interval);
      return;
    }
    if (!alive) {
      closeConn(doc, conn);
      clearInterval(interval);
      return;
    }
    alive = false;
    try {
      conn.ping();
    } catch {
      closeConn(doc, conn);
      clearInterval(interval);
    }
  }, PING_TIMEOUT);
  conn.on("close", () => {
    closeConn(doc, conn);
    clearInterval(interval);
  });

  // initial sync: step 1
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageSync);
    syncProtocol.writeSyncStep1(enc, doc);
    send(doc, conn, encoding.toUint8Array(enc));
  }
  // initial awareness snapshot
  const states = doc.awareness.getStates();
  if (states.size > 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageAwareness);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...states.keys()]));
    send(doc, conn, encoding.toUint8Array(enc));
  }
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => process.stderr.write(`[galacticboard-collab] listening on ws://localhost:${PORT}\n`));
