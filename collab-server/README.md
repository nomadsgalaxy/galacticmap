# GalacticBoard collaboration server

A small, self-hostable Yjs WebSocket relay that powers **real-time multiplayer** in GalacticBoard:
live presence cursors + conflict-free co-editing. It speaks the standard `y-websocket` wire
protocol (sync + awareness), keeping one shared `Y.Doc` per board in memory and fanning out live
edits + cursors to everyone connected to that board.

It is **optional and off by default** — without it, GalacticBoard is a normal single-user editor.
The database remains the canonical store; this server only relays live state between editors.

## Run

```bash
COLLAB_PORT=1234 node collab-server/index.mjs
```

Then tell the app where it is (this is a public, client-inlined var) and restart the app:

```bash
# .env
NEXT_PUBLIC_COLLAB_URL="ws://localhost:1234"
```

When set, every board editor connects to room = the board id. You'll see a green “Live” indicator,
avatars of other editors, their cursors, and each other's changes in real time.

## How it works

- **Sync**: each board is a `Y.Doc` with `nodes` and `edges` `Y.Map`s. The first editor to open a
  board seeds the shared doc from its DB-loaded graph; later editors adopt the shared state. Local
  store changes are mirrored into the maps (throttled), and remote map changes are applied back to
  the store — with an origin guard so there's no echo loop. Per-node last-write-wins keeps it
  conflict-free at object granularity.
- **Awareness/presence**: each client publishes `{ user: { name, color }, cursor }`; the app renders
  remote cursors (in flow space) and a presence avatar stack.
- **Persistence**: unchanged — each client still persists its own edits to the DB through the app's
  normal server actions. This server is a pure in-memory relay; when the last editor leaves a room,
  its doc is dropped.

## Production notes

- Put it behind TLS (`wss://`) via your reverse proxy and set `NEXT_PUBLIC_COLLAB_URL` to the
  `wss://` URL.
- It's single-process/in-memory. For multi-instance scale, front it with a shared Yjs backend
  (e.g. a Redis/database-backed provider) — the client protocol is unchanged.
- Auth: rooms are board ids. For hardened deployments, add a token check in the `upgrade` handler
  (the app already gates the editor by RBAC; this adds defense-in-depth at the socket).
