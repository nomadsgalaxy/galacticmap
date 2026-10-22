#!/usr/bin/env node
// GalacticBoard MCP server (feature #14).
//
// A thin, self-hostable Model Context Protocol server that exposes board operations as MCP
// tools. It talks to a running GalacticBoard instance over the public REST API (/api/v1) using
// a scoped API token, so it inherits the exact same RBAC the app enforces — an MCP client can
// never do more than the token's user is allowed to do.
//
// Run:
//   GALACTICBOARD_URL=http://localhost:3000 \
//   GALACTICBOARD_TOKEN=gbk_xxx \
//   node mcp-server/index.mjs
//
// Register with an MCP client (e.g. Claude Desktop / Claude Code) as a stdio server pointing at
// this file with those two env vars set. Mint the token at /settings/tokens.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.GALACTICBOARD_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.GALACTICBOARD_TOKEN;

if (!TOKEN) {
  process.stderr.write("[galacticboard-mcp] GALACTICBOARD_TOKEN is required (mint one at /settings/tokens)\n");
  process.exit(1);
}

/** Call the GalacticBoard REST API; throws on non-2xx with the server's error message. */
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
  }
  return data;
}

/** Fetch a binary API response (an image) as base64; throws like api(). */
async function apiBytes(path) {
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`GET ${path} -> ${res.status}: ${data.message || data.error || res.statusText}`);
  }
  return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: res.headers.get("content-type") ?? "image/png", alt: res.headers.get("x-alt-text") };
}

// Tool callbacks return MCP content; we serialize results as pretty JSON text.
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] });
// Wrap a handler so every tool shares the same ok/fail error contract.
const tool = (fn) => async (a) => {
  try {
    return ok(await fn(a));
  } catch (e) {
    return fail(e);
  }
};

const server = new McpServer(
  { name: "galacticboard", version: "1.2.0" },
  {
    instructions: [
      "Galactic Map boards are hand-made moodboards and mind maps on an infinite canvas. Treat a board like someone's desk: read it before you touch it, and keep their arrangement.",
      "",
      "Reading a board: describe_board gives every node's id, content and position, grouped the way the owner arranged it. view_board shows you the picture (numbered nodes, legend maps numbers to ids); use focus to zoom into a group or branch when the whole board is too small to read. view_image opens one image node. Look at the images before you describe, sort or add to a moodboard, because the alt text is often empty.",
      "",
      "How boards are built:",
      "- Mind map: a node's parentId makes it a child; children sit to the right of their parent in a column. Add ideas as children of the topic they belong to (parent, with no x/y) instead of loose nodes.",
      "- Moodboard: meaning is spatial. Nodes near each other belong together, groups (labelled, colored clouds) name a theme, swatches are the palette, images carry the mood. Add to an existing group with place.in or group, next to related nodes with place.near.",
      "- Connectors (add_edge) are for relationships that cross the tree or link areas, and a label says what the link means. Don't use them in place of parent links.",
      "- Tags group nodes across areas; reuse the board's existing tags before inventing new ones.",
      "",
      "Changing a board: batch everything in one apply_changes call. Leave out x/y and the server finds free space. Don't move or restyle the owner's nodes unless asked. Use mode 'propose' for ideas nobody explicitly asked for, so the owner accepts or discards each one. After a big change, call view_board to check it reads well.",
    ].join("\n"),
  },
);

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    description: "Verify the configured API token and return the GalacticBoard user + token scopes.",
    inputSchema: {},
  },
  tool(() => api("/me")),
);

server.registerTool(
  "list_boards",
  {
    title: "List boards",
    description: "List all boards the token's user can access, with role and node/edge counts.",
    inputSchema: {},
  },
  tool(() => api("/boards")),
);

server.registerTool(
  "describe_board",
  {
    title: "Describe board",
    description:
      "Read a board the way a person sees it: its groups (labelled clouds), ungrouped areas clustered by position, mind-map nesting, connectors, and variables, one line per node with its id, content, #tags and position. Start here before organizing or adding to a board, and pair it with view_board to see the layout and images; use get_board only when you need raw JSON.",
    inputSchema: {
      boardId: z.string().describe("Board id"),
      maxChars: z.number().int().min(1000).max(200000).optional().describe("Size budget for the outline (default 24000)"),
    },
  },
  async ({ boardId, maxChars }) => {
    try {
      const { outline } = await api(`/boards/${boardId}/outline${maxChars ? `?maxChars=${maxChars}` : ""}`);
      return { content: [{ type: "text", text: outline }] };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "view_board",
  {
    title: "View board",
    description:
      "See a board as a picture: groups, connectors, mind-map links, images and text, each node with a numbered badge. The legend maps each number to its node id. Pass focus (a group id, or a node id to see it with its mind-map branch) to zoom in when the whole board is too small to read.",
    inputSchema: {
      boardId: z.string().describe("Board id"),
      focus: z.string().optional().describe("Group or node id to zoom to"),
      width: z.number().int().min(400).max(2400).optional().describe("Image width in px (default 1400)"),
    },
  },
  async ({ boardId, focus, width }) => {
    try {
      const q = new URLSearchParams({ ...(focus ? { focus } : {}), ...(width ? { width: String(width) } : {}) });
      const s = await api(`/boards/${boardId}/snapshot${q.size ? `?${q}` : ""}`);
      const r = s.region;
      return {
        content: [
          { type: "image", data: s.data, mimeType: s.mimeType },
          { type: "text", text: [`${s.title}: showing x ${Math.round(r.x)}..${Math.round(r.x + r.w)}, y ${Math.round(r.y)}..${Math.round(r.y + r.h)}`, ...s.legend].join("\n") },
        ],
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "view_image",
  {
    title: "View image",
    description: "Open an image node and see the picture itself (scaled to max px on its long edge). If it has no alt text, consider adding a short one with apply_changes so the outline describes it next time.",
    inputSchema: {
      boardId: z.string().describe("Board id"),
      nodeId: z.string().describe("Image node id"),
      max: z.number().int().min(64).max(2048).optional().describe("Longest edge in px (default 1568)"),
    },
  },
  async ({ boardId, nodeId, max }) => {
    try {
      const img = await apiBytes(`/boards/${boardId}/nodes/${nodeId}/image${max ? `?max=${max}` : ""}`);
      const alt = img.alt ? decodeURIComponent(img.alt) : null;
      return { content: [{ type: "image", data: img.data, mimeType: img.mimeType }, { type: "text", text: alt ? `alt: ${alt}` : "(no alt text)" }] };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "apply_changes",
  {
    title: "Apply changes",
    description: [
      "Change a board in one all-or-nothing batch. People with the board open see the changes appear live.",
      "",
      'mode "apply" (default) writes directly. mode "propose" turns add_node/add_edge ops into ONE suggestion the board\'s editors accept or discard item by item (text, swatch and link nodes only) — prefer it for anything the human hasn\'t clearly asked for. dryRun:true validates and returns the result without saving.',
      "",
      "Ops (any id field also accepts a `ref` you gave something earlier in the same batch):",
      '- {op:"add_node", ref?, type:"text"|"swatch"|"link"|"image"|"spreadsheet"|"tracker", data?, place?:{near?:nodeId, in?:groupId, dir?:"right"|"left"|"above"|"below"}, parent?:nodeId, group?:groupId, x?, y?}',
      '    data by type: text {text (Markdown)}, swatch {hex:"#rrggbb"}, link {url, title?}, image {assetId, alt?}, spreadsheet {rows, cols, cells:{A1:"Hours", B1:"=SUM(B2:B5)"}}, tracker {title?, lines:["Total: sum(cost)"]}. Any type: tags[], notes.',
      "    Leave out x/y and the server finds free space next to place.near / place.in / the parent (or below the board). parent makes it a mind-map child; group adds it to a group.",
      '- {op:"update_node", id, data? (merged), addTags?, removeTags?, place? or x?/y? (move), width?, height?, parent? (null detaches), collapsed?}',
      '- {op:"delete_node", id}  (its connectors go too; children are detached)',
      '- {op:"add_edge", ref?, source, target, label?}  /  {op:"update_edge", id, label}  /  {op:"delete_edge", id}',
      '- {op:"add_group", ref?, label?, color?:"#rrggbb", tags?, nodes:[ids]}  /  {op:"update_group", id, label?, color?, tags?, addNodes?, removeNodes?}  /  {op:"delete_group", id}',
      "",
      "Returns refs (your ref → real id), the changed nodes/edges/groups, deleted ids, and versionId when a restorable snapshot was taken first (batches of 10+ ops or any delete).",
    ].join("\n"),
    inputSchema: {
      boardId: z.string(),
      ops: z.array(z.record(z.any())).min(1).max(200).describe("Operations, applied in order"),
      mode: z.enum(["apply", "propose"]).optional(),
      dryRun: z.boolean().optional(),
    },
  },
  tool(({ boardId, ops, mode, dryRun }) =>
    api(`/boards/${boardId}/changes`, { method: "POST", body: { ops, ...(mode ? { mode } : {}), ...(dryRun ? { dryRun } : {}) } })),
);

server.registerTool(
  "get_board",
  {
    title: "Get board",
    description: "Fetch a full board as raw JSON: metadata, all nodes, connector edges and groups. Mind-map parent links are on each node's parentId. For understanding a board, describe_board is usually better.",
    inputSchema: { boardId: z.string().describe("Board id") },
  },
  tool(({ boardId }) => api(`/boards/${boardId}`)),
);

server.registerTool(
  "create_board",
  {
    title: "Create board",
    description: "Create a new board. The token's user becomes its OWNER.",
    inputSchema: { title: z.string().optional().describe("Board title (default: 'Untitled board')") },
  },
  tool(({ title }) => api("/boards", { method: "POST", body: { title } })),
);

server.registerTool(
  "add_node",
  {
    title: "Add node",
    description:
      "Add one node at an exact position. For several nodes, automatic placement or links between new nodes, use apply_changes. type=text uses data.text (Markdown supported); swatch uses data.hex (#rrggbb); link uses data.url; image needs data.assetId; spreadsheet uses data.rows/cols/cells; tracker uses data.lines. Pass parentId to attach it as a mind-map child of another node.",
    inputSchema: {
      boardId: z.string(),
      type: z.enum(["text", "swatch", "image", "link", "spreadsheet", "tracker"]),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().nullable().optional(),
      data: z.record(z.any()).optional().describe('Per-type data, e.g. {"text":"# Idea"} or {"hex":"#6d28d9"}'),
    },
  },
  tool(({ boardId, type, x, y, parentId, data }) =>
    api(`/boards/${boardId}/nodes`, { method: "POST", body: { type, x, y, parentId, data } })),
);

server.registerTool(
  "update_node",
  {
    title: "Update node",
    description: "Update a node's data (merged), position, size, parent, or collapsed state.",
    inputSchema: {
      boardId: z.string(),
      nodeId: z.string(),
      data: z.record(z.any()).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().nullable().optional(),
      collapsed: z.boolean().optional(),
    },
  },
  tool(({ boardId, nodeId, ...patch }) =>
    api(`/boards/${boardId}/nodes/${nodeId}`, { method: "PATCH", body: patch })),
);

server.registerTool(
  "delete_node",
  {
    title: "Delete node",
    description: "Delete a node from a board.",
    inputSchema: { boardId: z.string(), nodeId: z.string() },
  },
  tool(({ boardId, nodeId }) => api(`/boards/${boardId}/nodes/${nodeId}`, { method: "DELETE" })),
);

server.registerTool(
  "link_nodes",
  {
    title: "Link nodes",
    description: "Create an animated connector edge between two nodes (a moodboard link, distinct from a mind-map parent/child relationship).",
    inputSchema: {
      boardId: z.string(),
      sourceId: z.string(),
      targetId: z.string(),
      label: z.string().optional(),
    },
  },
  tool(({ boardId, sourceId, targetId, label }) =>
    api(`/boards/${boardId}/edges`, { method: "POST", body: { sourceId, targetId, label } })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[galacticboard-mcp] connected to ${BASE} (stdio)\n`);
