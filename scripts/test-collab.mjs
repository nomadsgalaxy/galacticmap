// Dev-only: two Yjs clients against the collab server — verify doc sync + awareness propagate.
// Run (server must be up): node scripts/test-collab.mjs
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";

const URL = "ws://localhost:1234";
const ROOM = "smoke-test-room";

const docA = new Y.Doc();
const docB = new Y.Doc();
const pA = new WebsocketProvider(URL, ROOM, docA, { WebSocketPolyfill: WS });
const pB = new WebsocketProvider(URL, ROOM, docB, { WebSocketPolyfill: WS });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(800); // let both connect + sync

// 1) doc sync: write on A, read on B
const mapA = docA.getMap("nodes");
mapA.set("n1", { x: 10, y: 20, text: "hello from A" });
await wait(500);
const got = docB.getMap("nodes").get("n1");
console.log("DOC SYNC:", JSON.stringify(got));

// 2) awareness/presence: set state on A, see it on B
pA.awareness.setLocalState({ user: { name: "Alice", color: "#f00" }, cursor: { x: 1, y: 2 } });
await wait(500);
const remoteStates = [...pB.awareness.getStates().values()].filter((s) => s.user);
console.log("PRESENCE on B:", JSON.stringify(remoteStates));

console.log("CONNECTED A/B:", pA.wsconnected, pB.wsconnected);

pA.destroy();
pB.destroy();
process.exit(0);
