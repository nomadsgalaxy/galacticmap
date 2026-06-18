# GalacticBoard MCP server

A self-hostable [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI
client (Claude Desktop, Claude Code, etc.) read and edit your GalacticBoard boards. It is a thin
wrapper over the REST API (`/api/v1`), so it inherits the same per-board RBAC the app enforces —
an MCP client can never do more than the token's user is allowed to do.

## Setup

1. Mint an API token in the app at **Settings → API tokens** (`/settings/tokens`). Choose
   **Read & write** if you want the AI to create/edit boards, or **Read only** to keep it
   observational.
2. Point your MCP client at this server over stdio with two env vars:

```jsonc
// e.g. Claude Desktop config (claude_desktop_config.json) -> mcpServers
{
  "galacticboard": {
    "command": "node",
    "args": ["/absolute/path/to/GalacticBoard/mcp-server/index.mjs"],
    "env": {
      "GALACTICBOARD_URL": "http://localhost:3000",
      "GALACTICBOARD_TOKEN": "gbk_your_token_here"
    }
  }
}
```

`GALACTICBOARD_URL` defaults to `http://localhost:3000` if omitted. `GALACTICBOARD_TOKEN` is
required.

## Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `whoami` | read | Verify the token; return the user + scopes. |
| `list_boards` | read | List boards you can access (role + counts). |
| `get_board` | read | Full board: nodes, edges, mind-map parent links. |
| `create_board` | write | Create a board (you become OWNER). |
| `add_node` | write | Add a text/swatch/image/link node; optional `parentId` for a mind-map child. |
| `update_node` | write | Update a node's data/position/size/parent/collapsed. |
| `delete_node` | write | Delete a node. |
| `link_nodes` | write | Create an animated connector edge between two nodes. |

## Notes

- **Mind-map vs moodboard:** `add_node` with `parentId` attaches a node as a mind-map child;
  `link_nodes` creates a free moodboard connector. Both are optional — a board can be a pure
  moodboard with no links at all.
- **Node data shapes:** `text` → `{ "text": "# Markdown" }`, `swatch` → `{ "hex": "#6d28d9" }`,
  `link` → `{ "url": "https://…" }`, `image` → `{ "assetId": "…" }` (upload assets via the app).
- The server speaks stdio only; run one process per client.
