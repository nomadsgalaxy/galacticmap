"use client";

// Live board-global variable registry for client components (tracker nodes, spreadsheet cells, $name
// references). Original work under the OpenCommunityLicense. The scanner + evaluator live in the pure,
// React-free app/lib/variables.ts so server route handlers share the same implementation.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { scanVariables, type VarMap } from "../../../../lib/variables";

type VariablesValue = { vars: VarMap; names: string[] };

// SAFE empty default so a node consuming the hook never crashes before the provider is wired.
const EMPTY: VariablesValue = { vars: {}, names: [] };

const VariablesContext = createContext<VariablesValue>(EMPTY);

// Generic node list ({ type, data }[]) so BOTH the editor store nodes and the public nodes can feed it.
type ScannableNode = { type?: string; data?: Record<string, unknown> };

export function VariablesProvider({ nodes, children }: { nodes: ScannableNode[]; children: ReactNode }) {
  const value = useMemo<VariablesValue>(() => {
    const vars = scanVariables(nodes);
    return { vars, names: Object.keys(vars) };
  }, [nodes]);
  return <VariablesContext.Provider value={value}>{children}</VariablesContext.Provider>;
}

export function useVariables(): VariablesValue {
  return useContext(VariablesContext);
}
