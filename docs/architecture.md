# How the code is laid out

A map of the repo so you can find things fast. For why it's built this way, `plan.md` has the full spec and
decisions; `log.md` is the history.

## The big picture

One Next.js 16 app (App Router, `cacheComponents: true`) that does everything: pages, Server Actions, REST
API and SSE streams. It talks to SQLite through Prisma and keeps uploads on local disk under `data/`. Two
optional sidecars sit next to it:

- `collab-server/` is a Yjs WebSocket relay for live multiplayer (cursors + co-editing). Off unless
  `NEXT_PUBLIC_COLLAB_URL` is set. The DB stays the source of truth; this only relays.
- `mcp-server/` is a stdio MCP server that wraps `/api/v1`, so Claude and other MCP clients can read and edit
  boards with a personal API token. See its README.

Heads up, this isn't the Next.js most docs describe. Read `node_modules/next/dist/docs/` before changing
routing, caching or Server Actions (see `AGENTS.md`).

## Pages (`app/`)

| Route | What it is |
|---|---|
| `/` | Board manager (your boards) |
| `/login`, `/signup` | Auth (`app/(auth)/`). Email/password plus GitHub/GitLab OAuth when keys exist |
| `/boards/[id]` | The editor (`app/(editor)/boards/[id]/`) |
| `/boards/[id]/share`, `/members`, `/history` | Publish settings, membership/invites, saved versions |
| `/p/[secret]` | Public read-only view of a published board, with suggestions and votes |
| `/embed/[secret]` | Bare read-only embed (used by the galacticmap.app landing page) |
| `/galaxy` | Cross-board view: every board you can see, plus "hyperlanes" between them |
| `/invite/[token]` | Accept a board invitation |
| `/settings/account`, `/settings/tokens` | Account deletion, API tokens |
| `/admin` | Instance admin (only for `ADMIN_EMAILS`) |
| `/privacy` | Privacy policy |

## API (`app/api/`)

- `api/v1/*`: the public REST API. Bearer `gbk_…` tokens, scoped read or read/write, same RBAC as the UI.
  Boards, nodes, edges, variables, `me`. Shared helpers (`json`, `authed`, `readJson`) live in `api/v1/`.
- `api/boards/[id]/graph` (PATCH): the editor's save path. `export` and `boards/import` handle the portable
  board format. `live` and `suggest-stream` feed the realtime spectator and suggestion streams.
- `api/p/[secret]/*`: public endpoints for a published board: graph, SSE stream, suggest, vote, list
  suggestions. Rate limited, and Turnstile-gated when it's configured.
- `api/assets`: image upload and serving. `api/unfurl`: link-card previews. `api/auth`: Auth.js.

## Server logic (`app/lib/`)

| File | Does |
|---|---|
| `db.ts` | Prisma client singleton |
| `types.ts` | Shared types and **`parseNodeData`**, the Zod gate every `node.data` passes through. New node types or fields must be added here or saves fail or get stripped |
| `authz.ts` | Role → capability map. Default deny. The only place permissions are decided |
| `session.ts`, `auth-config.ts` | Current principal; which sign-in methods are on |
| `boards.ts`, `board-service.ts`, `board-actions.ts`, `board-io.ts` | Board reads, writes, Server Actions, import/export |
| `share-actions.ts`, `public-db.ts` | Publishing a board subset and reading the public snapshot |
| `member-actions.ts`, `version-actions.ts`, `tag-actions.ts`, `token-actions.ts` | Members/invites, versions, tags, API tokens |
| `api-token.ts` | Token minting. Only the sha256 is stored |
| `variables.ts` | `$var(...)` parsing and `Sum`/`Avg` evaluation. Pure TS, safe on client and server |
| `galaxy.ts`, `galaxy-actions.ts` | Cross-board view and links |
| `ai.ts`, `ai-actions.ts` | Generate map, expand node, summarize. Hidden unless `ANTHROPIC_API_KEY` is set |
| `live-bus.ts` | In-memory per-board event bus for the public SSE stream. Single instance only |
| `ratelimit.ts`, `net.ts` | In-memory token bucket; real client IP behind `TRUSTED_PROXY_HOPS` |
| `cache-tags.ts` | Cache tag names, shared by readers and mutators |
| `admin.ts`, `admin-actions.ts` | Instance-admin reads and actions |
| `storage/driver.ts` | Local disk storage for uploads (`data/uploads`). Swap point for S3/R2 |
| `theme/` | Material 3 colour derivation and the theme manager |

`live-bus.ts` and `ratelimit.ts` are in-memory, which is fine for the one container we run. Going to more than
one instance means swapping both for Redis.

## Editor (`app/(editor)/boards/[id]/_components/`)

`BoardCanvas.tsx` is the React Flow canvas. `nodes/` has one component per node type (text, image, link,
swatch, spreadsheet, tracker, cloud). `edges/` has the connector rendering and the orthogonal router, which is
specified in `docs/connector-routing.md`. Also here: `Inspector`, `CommandPalette` (Ctrl/⌘+K), `TagPanel`,
`VariablesContext`, and PNG/SVG/PDF export.

Shared UI used outside the editor (theme picker, bug reporter, import button, invite form) is in
`app/_components/`.

## Data (`prisma/schema.prisma`)

Users and boards: `User`, `Board`, `BoardMembership`, `Invitation`. Board content: `Node`, `Edge`,
`NodeGroup`, `Asset`, `BoardVersion`, `CrossBoardLink`. Publishing: `PublicShare`, `PublicShareNode`,
`PublicShareEdge`. Suggestions: `Suggestion`, `SuggestionVote`, `SuggestionThrottle`. API: `ApiToken`.

Local dev DB is `data/app.db`. Change the schema with `npm run db:migrate`; prod applies migrations on container
start.

## Scripts and tests

There's no test runner. `scripts/test-*.mjs` are standalone checks you run with `node` (orthogonal routing, line
jumps, spreadsheet formulas, variables, collab, MCP and more). `scripts/mint-test-token.mjs` makes an API token for
local testing, and `scripts/optimize-assets.mjs` recompresses uploads.

## Licensing note

The app ships under the Open Community License (see `LICENSE` / `NOTICE`). Things like the connector router and
the formula engine are original implementations built from public algorithms, not ports of third-party code.
Keep it that way when adding features.
