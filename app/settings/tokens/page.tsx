import { Suspense } from "react";
import { PageHeader } from "@/app/_components/PageHeader";
import { listApiTokens } from "@/app/lib/token-actions";
import { TokenManager } from "./TokenManager";

export default function TokensPage() {
  return (
    <main className="mx-auto w-full max-w-2xl p-6 pb-24">
      <PageHeader back="/" backLabel="Back to dashboard" title="API tokens" />
      <p className="mb-6 text-sm text-on-surface-variant">
        Personal access tokens for the Galactic Map REST API and the self-hostable MCP server.
        Tokens act as you and are governed by the same per-board roles as the app.
      </p>

      <Suspense fallback={<p className="text-sm text-on-surface-variant">Loading…</p>}>
        <Loader />
      </Suspense>

      <section className="mt-10 rounded-panel border border-outline-variant bg-surface-container p-4">
        <h2 className="mb-2 text-sm font-semibold text-on-surface">Quick start</h2>
        <pre className="overflow-x-auto rounded-control bg-surface-variant p-3 text-xs text-on-surface">
{`# Verify a token
curl -s http://localhost:3000/api/v1/me \\
  -H "Authorization: Bearer $GB_TOKEN"

# List boards
curl -s http://localhost:3000/api/v1/boards \\
  -H "Authorization: Bearer $GB_TOKEN"

# Create a board, then add a node
curl -s -X POST http://localhost:3000/api/v1/boards \\
  -H "Authorization: Bearer $GB_TOKEN" -H "Content-Type: application/json" \\
  -d '{"title":"From the API"}'

curl -s -X POST http://localhost:3000/api/v1/boards/<id>/nodes \\
  -H "Authorization: Bearer $GB_TOKEN" -H "Content-Type: application/json" \\
  -d '{"type":"text","x":0,"y":0,"data":{"text":"# Hello from curl"}}'`}
        </pre>
        <p className="mt-3 text-xs text-on-surface-variant">
          MCP: point your client at <code className="rounded bg-surface-variant px-1 py-0.5">mcp-server/index.mjs</code> with
          {" "}<code className="rounded bg-surface-variant px-1 py-0.5">GALACTICBOARD_URL</code> and{" "}
          <code className="rounded bg-surface-variant px-1 py-0.5">GALACTICBOARD_TOKEN</code> set. See{" "}
          <code className="rounded bg-surface-variant px-1 py-0.5">mcp-server/README.md</code>.
        </p>
      </section>
    </main>
  );
}

async function Loader() {
  const tokens = await listApiTokens();
  return <TokenManager initial={tokens} />;
}
