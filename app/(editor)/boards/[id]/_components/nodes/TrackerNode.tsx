"use client";

// A placeable tracker node: each line is a TEMPLATE — custom text with embedded computations substituted
// inline (e.g. "Price: $sum(ProjAPrice)" → "Price: $60") via the shared renderTrackerLine; empty lines
// fall back to an auto-list of every board variable with Sum/Avg/Count. Original work under the
// OpenCommunityLicense (math lives in sheetFormula/variables). Read-only on the public board (canEdit=false).
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";
import { type NodeProps } from "@xyflow/react";
import { Plus, X, Sigma } from "lucide-react";
import { NodeHandles } from "./NodeHandles";
import { RotateHandle } from "./RotateHandle";
import { useCanvasStore } from "../../_store/canvasStore";
import { updateNodeData } from "../../actions";
import { useVariables } from "../VariablesContext";
import { aggregate, renderTrackerLine } from "../../../../../lib/variables";

type TrackerData = { lines?: string[]; title?: string; rotation?: number };

const MAX_LINES = 50;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

export const TrackerNode = memo(function TrackerNode({ id, data, selected }: NodeProps) {
  const d = (data ?? {}) as TrackerData;
  const lines = Array.isArray(d.lines) ? (d.lines as string[]) : [];
  const title = typeof d.title === "string" ? d.title : "";
  const rotation = Number(d.rotation ?? 0);

  const boardId = useCanvasStore((s) => s.boardId);
  const canEdit = useCanvasStore((s) => s.canEdit);
  const setData = useCanvasStore((s) => s.updateNodeData);
  const { vars, names } = useVariables();

  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);

  const persist = useCallback(
    (patch: Record<string, unknown>) => {
      setData(id, patch);
      void updateNodeData(boardId, id, patch);
    },
    [boardId, id, setData],
  );

  // Each line is a template: literal text + inline-substituted computations, against the live registry.
  const computed = useMemo(
    () => lines.map((tpl) => ({ tpl, text: renderTrackerLine(tpl, vars) })),
    [lines, vars],
  );

  // Auto-list (no custom lines): every board variable with Sum / Avg / Count.
  const auto = useMemo(
    () => names.map((name) => ({ name, agg: aggregate(vars[name] ?? []) })),
    [names, vars],
  );

  const setLine = (i: number, value: string) => {
    const next = lines.slice();
    next[i] = value;
    persist({ lines: next });
  };
  const removeLine = (i: number) => persist({ lines: lines.filter((_, j) => j !== i) });
  const addLine = () => {
    if (lines.length >= MAX_LINES) return;
    const next = [...lines, ""];
    persist({ lines: next });
    setDraft("");
    setEditingLine(next.length - 1);
  };

  const commitLine = (i: number) => {
    setEditingLine(null);
    if (draft === (lines[i] ?? "")) return;
    if (draft.trim() === "") removeLine(i);
    else setLine(i, draft);
  };
  const beginEdit = (i: number) => {
    if (!canEdit) return;
    setDraft(lines[i] ?? "");
    setEditingLine(i);
  };

  return (
    <div
      className={`group relative min-w-[180px] max-w-[300px] rounded-panel border bg-surface text-on-surface shadow-elev-1 ${selected ? "border-primary ring-2 ring-primary/40" : "border-outline-variant"}`}
      style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: "center" } as CSSProperties}
    >
      <NodeHandles />
      {selected && canEdit && <RotateHandle nodeId={id} />}

      {/* Title row */}
      <div className="flex items-center gap-1.5 border-b border-outline-variant px-2.5 py-1.5">
        <Sigma size={13} className="shrink-0 text-on-surface-variant" />
        {editingTitle && canEdit ? (
          <input
            autoFocus
            className="nodrag w-full bg-transparent text-xs font-semibold text-on-surface outline-none"
            defaultValue={title}
            maxLength={120}
            spellCheck={false}
            onBlur={(e) => { setEditingTitle(false); if (e.target.value !== title) persist({ title: e.target.value.slice(0, 120) }); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
              else if (e.key === "Escape") { e.preventDefault(); setEditingTitle(false); }
            }}
          />
        ) : (
          <span
            className={`truncate text-xs font-semibold ${title ? "text-on-surface" : "text-on-surface-variant"} ${canEdit ? "cursor-text" : ""}`}
            onDoubleClick={() => canEdit && setEditingTitle(true)}
            title={canEdit ? "Double-click to rename" : undefined}
          >
            {title || "Tracker"}
          </span>
        )}
      </div>

      {/* Body: custom expression lines, or auto-listed variables when no lines exist. */}
      <div className="px-2.5 py-1.5">
        {lines.length === 0 ? (
          auto.length === 0 ? (
            <p className="py-1 text-[11px] leading-snug text-on-surface-variant">
              No variables yet. Type <code className="rounded bg-surface-container px-1">$name(value)</code> in a note
              {canEdit ? <>, then add a line like <code className="rounded bg-surface-container px-1">Price: $sum(name)</code> below.</> : "."}
            </p>
          ) : (
            <table className="w-full border-collapse text-xs tabular-nums">
              <tbody>
                {auto.map(({ name, agg }) => (
                  <tr key={name} className="align-baseline">
                    <td className="py-0.5 pr-2 font-medium text-on-surface">${name}</td>
                    <td className="py-0.5 text-right text-on-surface-variant">
                      <span title="Sum">Σ {fmt(agg.sum)}</span>
                      <span className="ml-2" title="Average">x̄ {fmt(agg.avg)}</span>
                      <span className="ml-2" title="Count">n {agg.count}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <ul className="space-y-0.5">
            {computed.map(({ tpl, text }, i) => (
              <li key={i} className="group/line flex items-center gap-1 text-xs">
                {canEdit && editingLine === i ? (
                  <input
                    autoFocus
                    className="nodrag w-full rounded bg-primary/5 px-1 py-0.5 text-xs text-on-surface outline-none"
                    value={draft}
                    spellCheck={false}
                    placeholder="Price: $sum(ProjAPrice)"
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitLine(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitLine(i); }
                      else if (e.key === "Escape") { e.preventDefault(); setEditingLine(null); }
                    }}
                  />
                ) : (
                  <>
                    <span
                      className={`min-w-0 flex-1 truncate font-medium text-on-surface ${canEdit ? "cursor-text" : ""}`}
                      onDoubleClick={() => beginEdit(i)}
                      title={canEdit ? `${tpl} — double-click to edit` : tpl}
                    >
                      {text || (canEdit ? "(empty — double-click)" : "")}
                    </span>
                    {canEdit && (
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); removeLine(i); }}
                        aria-label="Remove line"
                        className="nodrag shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 transition hover:bg-error-container hover:text-on-error-container group-hover/line:opacity-100"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && lines.length < MAX_LINES && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); addLine(); }}
            className="nodrag mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-on-surface-variant transition hover:bg-surface-variant active:scale-[.98]"
            title="Add an expression line"
          >
            <Plus size={11} /> line
          </button>
        )}
      </div>
    </div>
  );
});
