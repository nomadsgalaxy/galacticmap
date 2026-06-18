// Single source of truth for cache tags (plan.md §8). Imported by both readers and mutators.
export const tags = {
  board: (id: string) => `board:${id}`, // editable board graph (nodes/edges)
  boardMeta: (id: string) => `board:${id}:meta`, // title/settings only (disjoint from graph)
  boardsList: () => `boards:list`, // dashboard listing
  share: (slug: string) => `share:${slug}`, // published public snapshot
  shareByBoard: (id: string) => `board:${id}:share`, // bridge board id -> its share
  suggestions: (id: string) => `board:${id}:suggestions`, // pending suggestions list
} as const;
