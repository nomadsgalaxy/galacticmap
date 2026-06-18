"use client";

import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";
import { type NodeProps } from "@xyflow/react";
import { NodeHandles } from "./NodeHandles";
import { RotateHandle } from "./RotateHandle";
import { useCanvasStore } from "../../_store/canvasStore";
import { updateNodeData } from "../../actions";
import { evaluateCell, refName, colName, type CellGetter } from "./sheetFormula";
import { stripVarTokens, scanText, cellOutput, cellForEval } from "../../../../../lib/variables";
import { useVariables } from "../VariablesContext";

// A small editable spreadsheet: tabulate data + run calculations. Cells hold text, numbers, or "="
// formulas (cell refs, arithmetic, SUM/AVERAGE/MIN/MAX/COUNT — see sheetFormula). Stored in node.data as
// { rows, cols, cells: { A1: rawString, ... } }. Double-click a cell to edit its RAW value; the grid
// shows COMPUTED values otherwise. Read-only on the public board (canEdit=false).
type SheetData = { rows?: number; cols?: number; cells?: Record<string, string>; rotation?: number };

const MAX_ROWS = 50, MAX_COLS = 26;
const clampRows = (n: number) => Math.max(1, Math.min(MAX_ROWS, n));
const clampCols = (n: number) => Math.max(1, Math.min(MAX_COLS, n));
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

export const SpreadsheetNode = memo(function SpreadsheetNode({ id, data, selected }: NodeProps) {
  const d = (data ?? {}) as SheetData;
  const rows = clampRows(d.rows ?? 4);
  const cols = clampCols(d.cols ?? 4);
  const cells = (d.cells ?? {}) as Record<string, string>;
  const rotation = Number(d.rotation ?? 0);

  const boardId = useCanvasStore((s) => s.boardId);
  const canEdit = useCanvasStore((s) => s.canEdit);
  const setData = useCanvasStore((s) => s.updateNodeData);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Live board-global variable registry — fed to formulas (=Sum($cost), =$cost*1.1, …).
  const { vars } = useVariables();

  // A named-output cell ("$Name = formula") evaluates AS its formula when referenced by another cell.
  const getRaw = useCallback<CellGetter>((ref) => cellForEval(cells[ref] ?? ""), [cells]);

  // Computed display value for every non-empty cell. Formulas resolved against the live vars map;
  // plain cells have their $name(value) definition tokens stripped to the bare value (e.g. "$cost(30)"
  // shows "30"). `varCells` flags cells that held a definition so they get subtle gb-var styling.
  const { display, varCells } = useMemo(() => {
    const out: Record<string, string> = {};
    const flagged: Record<string, true> = {};
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ref = refName(c, r);
        const raw = cells[ref];
        if (raw == null || raw === "") continue;
        const named = cellOutput(raw);
        if (named) {
          // "$Name = formula": show the computed result + flag it (it exports `Name` to the registry).
          const v = evaluateCell("=" + named.expr, getRaw, vars);
          out[ref] = typeof v === "number" ? fmt(v) : String(v);
          flagged[ref] = true;
        } else if (raw[0] === "=") {
          const v = evaluateCell(raw, getRaw, vars);
          out[ref] = typeof v === "number" ? fmt(v) : String(v);
        } else {
          // stripVarTokens swaps each numeric $name(content) token for its content VERBATIM and leaves
          // non-numeric tokens literal (e.g. "$cost(30)" → "30", "$x(free)" → "$x(free)").
          out[ref] = stripVarTokens(raw);
          // A cell IS a var-cell iff it contains at least one NUMERIC token (scanText returns only those).
          if (scanText(raw).length > 0) flagged[ref] = true;
        }
      }
    }
    return { display: out, varCells: flagged };
  }, [cells, rows, cols, getRaw, vars]);

  const persist = useCallback(
    (patch: Record<string, unknown>) => {
      setData(id, patch);
      void updateNodeData(boardId, id, patch);
    },
    [boardId, id, setData],
  );

  const commit = (ref: string) => {
    setEditing(null);
    const cur = cells[ref] ?? "";
    if (draft === cur) return;
    const next = { ...cells };
    if (draft.trim() === "") delete next[ref];
    else next[ref] = draft;
    persist({ cells: next });
  };

  const beginEdit = (ref: string) => {
    if (!canEdit) return;
    setDraft(cells[ref] ?? "");
    setEditing(ref);
  };

  const resize = (dr: number, dc: number) => persist({ rows: clampRows(rows + dr), cols: clampCols(cols + dc) });

  const cellBase = "border border-outline-variant min-w-[48px] max-w-[140px] h-[22px] px-1 text-xs align-middle";

  return (
    <div
      className={`group relative rounded-panel border bg-surface text-on-surface shadow-elev-1 ${selected ? "border-primary ring-2 ring-primary/40" : "border-outline-variant"}`}
      style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: "center" } as CSSProperties}
    >
      <NodeHandles />
      {selected && canEdit && <RotateHandle nodeId={id} />}
      <table className="border-collapse select-none" style={{ borderSpacing: 0 }}>
        <thead>
          <tr>
            {/* corner + column headers are NOT nodrag → drag here to move the node */}
            <th className={`${cellBase} bg-surface-container text-on-surface-variant cursor-grab`} />
            {Array.from({ length: cols }, (_, c) => (
              <th key={c} className={`${cellBase} bg-surface-container text-center font-medium text-on-surface-variant cursor-grab`}>{colName(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              <th className={`${cellBase} bg-surface-container text-center font-medium text-on-surface-variant cursor-grab`}>{r + 1}</th>
              {Array.from({ length: cols }, (_, c) => {
                const ref = refName(c, r);
                const isEditing = canEdit && editing === ref;
                return (
                  <td key={c} className={`${cellBase} p-0`}>
                    {isEditing ? (
                      <input
                        autoFocus
                        className="nodrag h-full w-full bg-primary/5 px-1 text-xs text-on-surface outline-none"
                        value={draft}
                        spellCheck={false}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commit(ref)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commit(ref); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <div
                        className={`nodrag h-full w-full cursor-text overflow-hidden whitespace-nowrap px-1 leading-[22px]${varCells[ref] ? " gb-var" : ""}`}
                        title={cells[ref] && cells[ref] !== display[ref] ? cells[ref] : undefined}
                        onDoubleClick={() => beginEdit(ref)}
                      >
                        {display[ref] ?? ""}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {selected && canEdit && (
        // Row/column add+remove. nodrag + stopPropagation so the pane doesn't treat clicks as pan/drag.
        <div className="nodrag absolute -bottom-7 left-0 flex gap-1 text-[10px]">
          {([
            ["+ row", 1, 0], ["– row", -1, 0], ["+ col", 0, 1], ["– col", 0, -1],
          ] as const).map(([label, dr, dc]) => (
            <button
              key={label}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); resize(dr, dc); }}
              className="rounded-control border border-outline-variant bg-surface-container px-1.5 py-0.5 text-on-surface-variant hover:bg-primary hover:text-on-primary"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
