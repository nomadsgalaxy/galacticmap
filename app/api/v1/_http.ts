import { ZodError } from "zod";
import { authenticateApiToken, type ApiPrincipal, type TokenScope } from "@/app/lib/api-token";
import { ApiError } from "@/app/lib/board-service";
import { ForbiddenError } from "@/app/lib/authz";

// Shared plumbing for the versioned REST API (#14). Underscore-prefixed so Next does not treat
// this as a route. Every handler is wrapped by handle() for uniform JSON errors + CORS-free,
// no-store responses (the API is token-authed, never cached).

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Resolve the API principal from the Bearer token, asserting a minimum scope. */
export async function authed(req: Request, scope: TokenScope = "read"): Promise<ApiPrincipal> {
  const principal = await authenticateApiToken(req);
  if (!principal) {
    throw new ApiError(401, "Missing or invalid API token. Send 'Authorization: Bearer gbk_…'.", "unauthorized");
  }
  if (!principal.scopes.has(scope)) {
    throw new ApiError(403, `This token lacks the '${scope}' scope.`, "insufficient_scope");
  }
  return principal;
}

/** Parse + require a JSON body object (else 400). */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(400, "Request body must be valid JSON", "bad_json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "Request body must be a JSON object", "bad_json");
  }
  return body as Record<string, unknown>;
}

/** Wrap a route handler: maps known errors to clean JSON; unknown errors to 500. */
export function handle(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((err: unknown) => {
    if (err instanceof ApiError) return json({ error: err.code, message: err.message }, err.status);
    if (err instanceof ForbiddenError) return json({ error: "forbidden", message: err.message }, 403);
    if (err instanceof ZodError) {
      return json(
        { error: "validation", message: "Invalid payload", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        400,
      );
    }
    console.error("[api/v1] unhandled error:", err);
    return json({ error: "internal", message: "Internal server error" }, 500);
  });
}
