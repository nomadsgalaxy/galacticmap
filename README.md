# Galactic Map

A self-hostable, hybrid **moodboard + mind-map**. Drop images, color swatches, links, text, spreadsheets, and live "variable trackers" onto an infinite canvas, connect them with smart orthogonal connectors, group them into labelled clouds, and publish a read-only public view that anyone can browse (and optionally suggest changes to).

Galactic Map by [NomadsGalaxy](https://www.nomadsgalaxy.com).

## Features

- **Infinite canvas** with pan/zoom, rotation, drag-resize, alignment guides and a gentle grid.
- **Node types** — rich-text (Markdown), images (cropped/zoomed, auto-optimized on upload), color swatches, link cards, spreadsheets with formulas, and variable trackers.
- **Smart connectors** — original orthogonal router (clean L/Z/U routing that bends around nodes), line-jumps where trails cross, manual waypoints, and a directional comet that shows flow.
- **Trackable variables** — write `$cost(30)` anywhere and reference it (`Sum($cost)`, `Avg($cost)`) in spreadsheets, trackers, or a HUD; spreadsheet cells can export their result as a variable too. Readable over the API.
- **Grouping** into labelled, colored clouds; tags and tag filtering; branch focus and collapse.
- **Collaboration** — realtime multi-cursor editing, plus a moderated public-suggestions workflow for anonymous visitors.
- **Sharing** — publish a board to a read-only public link with a clean "stream" mode.
- **Keyboard-first** — hold a node-type key (Tab = text, C = color, L = link, S = spreadsheet, V = tracker) and press an arrow to spawn a connected node in that direction; ⌘/Ctrl+K command palette.

## Tech stack

Next.js (App Router) · React 19 · [React Flow](https://reactflow.dev) (`@xyflow/react`) · Prisma + SQLite (swap the datasource for Postgres) · Auth.js v5 · Tailwind CSS 4 · Material 3 tokens.

## Self-hosting

Requirements: Node.js 20+.

```bash
git clone https://github.com/nomadsgalaxy/galacticmap.git
cd galacticmap
npm install

cp .env.example .env          # then fill in the values below
npx prisma migrate deploy     # create the SQLite schema
npm run dev                   # http://localhost:3000
```

Minimum `.env`:

- `DATABASE_URL` — defaults to a local SQLite file at `data/app.db`.
- `AUTH_SECRET` — generate with `openssl rand -base64 32`.
- `ADMIN_EMAILS` — comma-separated emails that get instance-admin rights.

Optional integrations (GitHub/GitLab OAuth, an Anthropic API key for the AI features, Cloudflare Turnstile for anonymous-suggestion challenges) are documented in `.env.example`; each feature stays hidden until its keys are present.

For production: `npm run build` then `npm run start`. Uploaded images and the SQLite database both live under `data/` — back up that one folder.

## License

Galactic Map is released under the **Open Community License v1.1** with the **SWAtt v1** (software attribution) and **Micro v1** (micro-business) add-on conditions — see [`LICENSE`](./LICENSE) and the [`NOTICE`](./NOTICE) summary.

In short: you're free to use, modify, and redistribute it, including commercially up to €1,000,000 annual gross revenue; derivatives must keep the license and a visible "Galactic Map by NomadsGalaxy" attribution.
