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
      "GALACTICBOARD_URL": "https://chart.galacticmap.app",
      "GALACTICBOARD_TOKEN": "gbk_your_token_here"
    }
  }
}
```

Use your own instance's address for `GALACTICBOARD_URL`. It defaults to `http://localhost:3000` (a local dev server) if omitted. `GALACTICBOARD_TOKEN` is
required.

## Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `whoami` | read | Verify the token; return the user + scopes. |
| `list_boards` | read | List boards you can access (role + counts). |
| `describe_board` | read | The board as readable text: groups, ungrouped areas, mind-map nesting, connectors and variables, one line per node with its id. Start here. |
| `view_board` | read | The board as a picture: groups, connectors, mind-map links, images and text, each node numbered, with a legend mapping numbers to ids. `focus` zooms to a group, or to a node and its branch. |
| `view_image` | read | Open one image node and see the picture itself, plus its caption. |
| `add_image` | write | Put a picture on a board from a local file or an http(s) URL (PNG, JPEG, GIF or WebP, up to 10 MB). Placement works like `apply_changes`. |
| `apply_changes` | write | Add, update or delete nodes, connectors and groups in one all-or-nothing batch. Leave out x/y and the server finds free space, sized to each card's real content. `arrange` lays out a mind-map branch as a tidy tree. The result lists layout warnings (overlapping cards, cards inside a group they aren't in). `mode: "propose"` sends additions to the owner as a suggestion to accept or discard instead. |
| `get_board` | read | Full board as raw JSON: nodes, edges, groups, mind-map parent links. |
| `create_board` | write | Create a board (you become OWNER). |
| `add_node` | write | Add one node at an exact position; optional `parentId` for a mind-map child. |
| `update_node` | write | Update a node's data/position/size/parent/collapsed. |
| `delete_node` | write | Delete a node. |
| `link_nodes` | write | Create an animated connector edge between two nodes. |

## Working with people

- Changes made through the API show up live for anyone with the board open, and new nodes are
  credited to the token's name with "(agent)" after it. Name the token after the agent.
- `apply_changes` with `mode: "propose"` doesn't touch the board. The additions appear as ghosts
  that an editor accepts or discards one by one. Proposals can add text, swatch and link nodes and
  connectors; edits, moves and deletes need `mode: "apply"`. If the board was never published, a
  private share is created to hold proposals. It stays unpublished until the owner publishes.
- Before a batch of 10+ ops or any delete, the board is snapshotted to History as
  "Before agent changes", so one click restores it. The last 10 of these are kept.
- `dryRun: true` checks a batch and returns what it would do, without saving.

## Notes

- **Mind-map vs moodboard:** `add_node` with `parentId` attaches a node as a mind-map child;
  `link_nodes` creates a free moodboard connector. Both are optional — a board can be a pure
  moodboard with no links at all.
- **Node data shapes:** `text` → `{ "text": "# Markdown" }`, `swatch` → `{ "hex": "#6d28d9" }`,
  `link` → `{ "url": "https://…" }`, `image` → `{ "assetId": "…" }` (upload assets via the app),
  `spreadsheet` → `{ "rows": 4, "cols": 3, "cells": { "A1": "Hours", "B1": "=SUM(B2:B4)" } }`,
  `tracker` → `{ "title": "Budget", "lines": ["Total: sum(cost)"] }`. Every type also takes `tags` and `notes`.
- The server speaks stdio only; run one process per client.
