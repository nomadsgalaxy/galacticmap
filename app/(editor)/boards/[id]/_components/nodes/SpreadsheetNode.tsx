"use client";

import { memo, useCallback, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { type NodeProps } from "@xyflow/react";
import { NodeHandles } from "./NodeHandles";
import { RotateHandle } from "./RotateHandle";
import { useCanvasStore } from "../../_store/canvasStore";
import { updateNodeData } from "../../actions";
import { evaluateCellDisplay, refName, colName, SHEET_MAX_ROWS as MAX_ROWS, SHEET_MAX_COLS as MAX_COLS, type CellGetter } from "./sheetFormula";
import { stripVarTokens, scanText, cellOutput, cellForEval, aggregate, formatVar } from "../../../../../lib/variables";
import { useVariables } from "../VariablesContext";
import { typingAt, callAt, suggestFunctions, suggestVariables, fnDoc, splitArgs, argIndex } from "./sheetFunctions";

type Option = { label: string; insert: string; detail: string };

// A small editable spreadsheet: tabulate data + run calculations. Cells hold text, numbers, or "="
// formulas (Excel-compatible — see sheetFormula; autocomplete comes from sheetFunctions). Stored in node.data as
// { rows, cols, cells: { A1: rawString, ... } }. Double-click a cell to edit its RAW value; the grid
// shows COMPUTED values otherwise. Read-only on the public board (canEdit=false).
type SheetData = { rows?: number; cols?: number; cells?: Record<string, string>; rotation?: number };

const clampRows = (n: number) => Math.max(1, Math.min(MAX_ROWS, n));
const clampCols = (n: number) => Math.max(1, Math.min(MAX_COLS, n));

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
  const { vars, units, names } = useVariables();

  // Formula autocomplete: function names (with their arguments) and $variables as you type, then a hint
  // for the arguments of the function the caret is inside. The popup is portalled to the page and placed
  // under the cell on screen, so it stays readable at any canvas zoom.
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false); // Escape hides the list until the next keystroke
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const placeUnder = (el: Element | null | undefined) => {
    const r = el?.getBoundingClientRect();
    setAnchor(r ? { left: r.left, top: r.bottom + 4 } : null);
  };
  const typing = editing ? typingAt(draft, caret) : null;
  const options: Option[] =
    typing?.kind === "fn"
      ? suggestFunctions(typing.prefix).map((f) => ({ label: `${f.name}(${f.args})`, insert: `${f.name}(`, detail: f.desc }))
      : typing?.kind === "var"
        ? suggestVariables(typing.prefix, names).map((n) => ({
            label: `$${n}`, insert: `$${n}`,
            detail: `${formatVar(aggregate(vars[n] ?? []).sum, units[n])}${(vars[n]?.length ?? 0) > 1 ? ` (sum of ${vars[n].length})` : ""}`,
          }))
        : [];
  const listOpen = !dismissed && options.length > 0;
  const call = editing && !listOpen ? callAt(draft, caret) : null;
  const callDoc = call ? fnDoc(call.name) : undefined;

  const accept = (o: Option) => {
    if (!typing) return;
    const insert = o.insert.endsWith("(") && draft[caret] === "(" ? o.insert.slice(0, -1) : o.insert;
    const next = draft.slice(0, typing.start) + insert + draft.slice(caret);
    const pos = typing.start + insert.length;
    setDraft(next);
    setCaret(pos);
    setPick(0);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(pos, pos));
  };

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
          out[ref] = evaluateCellDisplay("=" + named.expr, getRaw, vars, units);
          flagged[ref] = true;
        } else if (raw[0] === "=") {
          out[ref] = evaluateCellDisplay(raw, getRaw, vars, units);
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
  }, [cells, rows, cols, getRaw, vars, units]);

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

  const beginEdit = (ref: string, cell?: HTMLElement | null) => {
    if (!canEdit) return;
    const raw = cells[ref] ?? "";
    setDraft(raw);
    setCaret(raw.length);
    setPick(0);
    setDismissed(false);
    placeUnder(cell);
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
      {/* Clip the grid to the rounded corners here, not on the outer box: its handles and row/col buttons sit outside it. */}
      <div className="overflow-hidden rounded-[inherit]">
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
                        ref={inputRef}
                        autoFocus
                        className="nodrag h-full w-full bg-primary/5 px-1 text-xs text-on-surface outline-none"
                        value={draft}
                        spellCheck={false}
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded={listOpen}
                        aria-controls={listOpen ? listId : undefined}
                        aria-activedescendant={listOpen ? `${listId}-${pick}` : undefined}
                        onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setDismissed(false); setPick(0); placeUnder(e.target); }}
                        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                        onBlur={() => commit(ref)}
                        onKeyDown={(e) => {
                          if (listOpen) {
                            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                              e.preventDefault();
                              const step = e.key === "ArrowDown" ? 1 : -1;
                              setPick((p) => (p + step + options.length) % options.length);
                              return;
                            }
                            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); accept(options[Math.min(pick, options.length - 1)]); return; }
                            if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
                          }
                          if (e.key === "Enter") { e.preventDefault(); commit(ref); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <div
                        className={`nodrag h-full w-full cursor-text overflow-hidden whitespace-nowrap px-1 leading-[22px]${varCells[ref] ? " gb-var" : ""}`}
                        title={cells[ref] && cells[ref] !== display[ref] ? cells[ref] : undefined}
                        onDoubleClick={(e) => beginEdit(ref, e.currentTarget.parentElement)}
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
      </div>
      {editing && anchor && (listOpen || callDoc) && createPortal(
        // mousedown is swallowed so clicking an option doesn't blur (and commit) the cell.
        <div
          className="fixed z-[1000] w-max min-w-[220px] max-w-[340px] overflow-hidden rounded-control border border-outline-variant bg-surface-container text-xs text-on-surface shadow-elev-2"
          style={{ left: anchor.left, top: anchor.top }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {listOpen ? (
            <ul id={listId} role="listbox" className="py-1">
              {options.map((o, i) => (
                <li
                  key={o.label}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === pick}
                  className={`cursor-pointer px-2 py-1 ${i === pick ? "bg-primary/10" : ""}`}
                  onMouseEnter={() => setPick(i)}
                  onClick={() => accept(o)}
                >
                  <div className="truncate font-mono text-[11px]">{o.label}</div>
                  {o.detail && <div className="truncate text-[10px] text-on-surface-variant">{o.detail}</div>}
                </li>
              ))}
            </ul>
          ) : callDoc && call ? (
            <div className="px-2 py-1.5" role="tooltip">
              <div className="font-mono text-[11px]">
                {callDoc.name}(
                {splitArgs(callDoc.args).map((a, i, all) => (
                  <span key={i}>
                    <span className={i === argIndex(all, call.arg) ? "font-semibold text-primary" : "text-on-surface-variant"}>{a}</span>
                    {i < all.length - 1 ? ", " : ""}
                  </span>
                ))}
                )
              </div>
              <div className="text-[10px] text-on-surface-variant">{callDoc.desc}</div>
            </div>
          ) : null}
        </div>,
        document.body,
      )}
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
