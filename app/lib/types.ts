import { z } from "zod";

// ── RBAC value set (String column on SQLite; real union in TS) ──
export const ROLES = ["OWNER", "TEAM", "VISITOR"] as const;
export type Role = (typeof ROLES)[number];

// ── Node types + per-type data schemas (Zod-validated; stored as opaque JSON) ──
export const NODE_TYPES = ["text", "swatch", "image", "link", "spreadsheet", "tracker"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// Common fields available on every node type (notes / icons / tags / per-node style).
const common = {
  notes: z.string().max(20000).optional(),
  icons: z.array(z.string().max(16)).max(24).optional(),
  tags: z.array(z.string().max(40)).max(50).optional(),
  // attribution when a node is materialized from a public suggestion
  credit: z
    .object({ name: z.string().max(80), suggestedAt: z.string().max(40).optional() })
    .optional(),
  // freeform tilt (deg, drag-rotate handle) + per-node trackable-variable template ($name(value)) and
  // whether to show it on the node. Available on EVERY type, so they round-trip through parseNodeData.
  rotation: z.number().min(-360).max(360).optional(),
  varText: z.string().max(500).optional(),
  showVars: z.boolean().optional(),
};

export const TextData = z.object({
  text: z.string().max(5000).default(""),
  // Per-node text formatting (markdown still handles inline bold/italic/etc.).
  align: z.enum(["left", "center", "right"]).optional(),
  fontSize: z.number().min(10).max(64).optional(), // px
  fontFamily: z.enum(["sans", "serif", "mono"]).optional(),
  ...common,
});
export const SwatchData = z.object({
  hex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
    .default("#6d28d9"),
  ...common,
});
export const ImageData = z.object({
  assetId: z.string().min(1),
  alt: z.string().max(500).optional(),
  // Crop/scale: "contain" shows the whole image (letterboxed); "cover" fills the frame and the frame
  // becomes the crop window — zoom (≥1) + focal point (posX/posY %) choose what shows.
  fit: z.enum(["contain", "cover"]).optional(),
  zoom: z.number().min(1).max(6).optional(),
  posX: z.number().min(0).max(100).optional(),
  posY: z.number().min(0).max(100).optional(),
  ...common,
});
export const LinkData = z.object({
  // Optional + not strictly URL-validated: a link node can be created empty (e.g. via the connect-arrow
  // picker, which seeds {url:""}) and its URL set later in the Inspector. LinkNode parses it defensively.
  url: z.string().max(2000).optional(),
  title: z.string().max(300).optional(),
  description: z.string().max(600).optional(),
  image: z.string().max(2000).optional(),
  favicon: z.string().max(2000).optional(),
  ...common,
});
export const SpreadsheetData = z.object({
  rows: z.number().int().min(1).max(50).optional(),
  cols: z.number().int().min(1).max(26).optional(),
  // cell ref ("A1") → raw string (number, text, "=formula", or a $name(value) token). ≤50×26 cells.
  cells: z.record(z.string().max(500)).optional(),
  ...common,
});
export const TrackerData = z.object({
  title: z.string().max(200).optional(),
  lines: z.array(z.string().max(200)).max(50).optional(), // tracker expressions, e.g. "Sum($cost)"
  ...common,
});

/** Validate+normalize a node's `data` blob for its type. Throws on invalid. */
export function parseNodeData(type: string, data: unknown): Record<string, unknown> {
  switch (type) {
    case "text":
      return TextData.parse(data ?? {});
    case "swatch":
      return SwatchData.parse(data ?? {});
    case "image":
      return ImageData.parse(data ?? {});
    case "link":
      return LinkData.parse(data ?? {});
    case "spreadsheet":
      return SpreadsheetData.parse(data ?? {});
    case "tracker":
      return TrackerData.parse(data ?? {});
    default:
      throw new Error(`Unknown node type: ${type}`);
  }
}

// ── Serialized snapshot (plain, cache- and client-safe; no Date/Prisma objects) ──
export type SnapshotNode = {
  id: string;
  type: string;
  parentId: string | null;
  layout: string; // "auto" | "manual"
  collapsed: boolean;
  order: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  zIndex: number;
  data: Record<string, unknown>;
  style?: Record<string, unknown> | null;
};

export type SnapshotEdge = {
  id: string;
  source: string;
  target: string;
  kind: string; // "connector"
  type: string; // React Flow edgeTypes key, e.g. "animated"
  animated: boolean;
  label: string | null;
  data: Record<string, unknown>;
  style?: Record<string, unknown> | null;
};
