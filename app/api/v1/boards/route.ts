import { authed, handle, json, readJson } from "@/app/api/v1/_http";
import { createBoardSvc, listBoards } from "@/app/lib/board-service";

// GET  /api/v1/boards        — boards the token's user can access (with role + counts)
// POST /api/v1/boards {title} — create a board (token user becomes OWNER)
export function GET(req: Request) {
  return handle(async () => {
    const principal = await authed(req, "read");
    return json({ boards: await listBoards(principal) });
  });
}

export function POST(req: Request) {
  return handle(async () => {
    const principal = await authed(req, "write");
    const body = await readJson(req);
    const title = typeof body.title === "string" ? body.title : undefined;
    const board = await createBoardSvc(principal, title);
    return json({ board }, 201);
  });
}
