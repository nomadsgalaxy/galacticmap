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

const server = new McpServer({ name: "galacticboard", version: "1.0.0" });

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
  "get_board",
  {
    title: "Get board",
    description: "Fetch a full board: metadata, all nodes (text/swatch/image/link), and connector edges. Mind-map parent links are on each node's parentId.",
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
      "Add a node to a board. type=text uses data.text (Markdown supported); swatch uses data.hex (#rrggbb); link uses data.url; image needs data.assetId. Pass parentId to attach it as a mind-map child of another node.",
    inputSchema: {
      boardId: z.string(),
      type: z.enum(["text", "swatch", "image", "link"]),
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
