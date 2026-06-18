import { create } from "zustand";

// A tiny shared registry so each connector can see the OTHER connectors' rendered geometry — React
// Flow renders every edge as an isolated SVG component with no knowledge of its siblings, so to draw
// line-jumps (hops where two trails cross) each edge publishes its sampled polyline here and reads
// the rest back. Only populated while line-jumps are enabled.
type Pt = { x: number; y: number };

type EdgePathState = {
  polys: Record<string, Pt[]>;
  publish: (id: string, pts: Pt[]) => void;
  drop: (id: string) => void;
};

export const useEdgePaths = create<EdgePathState>((set) => ({
  polys: {},
  publish: (id, pts) => set((s) => ({ polys: { ...s.polys, [id]: pts } })),
  drop: (id) =>
    set((s) => {
      if (!(id in s.polys)) return s;
      const next = { ...s.polys };
      delete next[id];
      return { polys: next };
    }),
}));
