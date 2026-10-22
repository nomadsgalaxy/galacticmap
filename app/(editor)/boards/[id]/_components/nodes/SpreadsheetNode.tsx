"use client";

import { memo, useCallback, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { type NodeProps } from "@xyflow/react";
import { NodeHandles } from "./NodeHandles";
import { RotateHandle } from "./RotateHandle";
import { useCanvasStore } from "../../_store/canvasStore";
import { updateNodeData } from "../../actions";
import { evaluateCellDisplay, refName, colName, parseRef, SHEET_MAX_ROWS as MAX_ROWS, SHEET_MAX_COLS as MAX_COLS, type CellGetter } from "./sheetFormula";
import { stripVarTokens, scanText, cellOutput, cellForEval, aggregate, formatVar } from "../../../../../lib/variables";
import { useVariables } from "../VariablesContext";
import { typingAt, callAt, suggestFunctions, suggestVariables, fnDoc, splitArgs, argIndex } from "./sheetFunctions";
import { fillRange, fillCells, inRange, insertLines, type CellRange } from "./sheetFill";

type Option = { label: string; insert: string; detail: string };

// A small editable spreadsheet: tabulate data + run calculations. Cells hold text, numbers, or "="
// formulas (Excel-compatible — see sheetFormula; autocomplete comes from sheetFunctions). Stored in node.data as
// { rows, cols, cells: { A1: rawString, ... } }. Double-click a cell to edit its RAW value; the grid
// shows COMPUTED values otherwise. Read-only on the public board (canEdit=false).
type SheetData = { rows?: number; cols?: number; cells?: Record<string, string>; rotation?: number };

const clampRows = (n: number) => Math.max(1, Math.min(MAX_ROWS, n));
const clampCols = (n: number) => Math.max(1, Math.min(MAX_COLS, n));
const ARROWS: Record<string, [number, number] | undefined> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

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
  // Click a cell to select it; drag its corner handle to copy it down/up/across, like Excel's fill handle.
  const [sel, setSel] = useState<string | null>(null);
  const [fill, setFill] = useState<CellRange | null>(null);
  const activeSel = selected && canEdit ? sel : null; // the handle only shows while the sheet itself is selected
  const [menu, setMenu] = useState<{ ref: string; x: number; y: number } | null>(null); // right-click on a cell
  const gridRef = useRef<HTMLDivElement>(null);
  // The selected cell holds keyboard focus (tabIndex -1), so typing, arrows and Delete reach it. Its "nokey"
  // class tells React Flow and the board's shortcuts to leave those keys alone (no node delete or nudge).
  // Focus right away when moving around the grid, so the next key lands on the new cell. Coming out of
  // the editor (`later`), wait a frame: the cell's div replaces the input on the next render.
  const focusCell = (ref: string, later = false) => {
    const go = () => (gridRef.current?.querySelector(`[data-cell="${ref}"] > div`) as HTMLElement | null)?.focus();
    if (later) requestAnimationFrame(go);
    else go();
  };

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
  // This sheet's own cell refs, so a fill drag ignores cells of another sheet under the pointer.
  const refsHere = useMemo(() => {
    const m: Record<string, true> = {};
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m[refName(c, r)] = true;
    return m;
  }, [rows, cols]);

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

  // Double-click, Enter or F2 edits what's there; typing a character replaces it, like Excel.
  const beginEdit = (ref: string, cell?: HTMLElement | null, typed?: string) => {
    if (!canEdit) return;
    const raw = typed ?? cells[ref] ?? "";
    setDraft(raw);
    setCaret(raw.length);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(raw.length, raw.length));
    setPick(0);
    setDismissed(false);
    placeUnder(cell);
    setEditing(ref);
  };

  const resize = (dr: number, dc: number) => persist({ rows: clampRows(rows + dr), cols: clampCols(cols + dc) });

  const moveSel = (ref: string, dr: number, dc: number, later = false) => {
    const p = parseRef(ref);
    if (!p) return;
    const next = refName(Math.max(0, Math.min(cols - 1, p.col + dc)), Math.max(0, Math.min(rows - 1, p.row + dr)));
    setSel(next);
    focusCell(next, later);
  };

  const onCellKey = (e: React.KeyboardEvent<HTMLDivElement>, ref: string) => {
    if (activeSel !== ref) return;
    const step = ARROWS[e.key];
    const typed = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!step && !typed && !["Tab", "Enter", "F2", "Delete", "Backspace"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (step) moveSel(ref, step[0], step[1]);
    else if (e.key === "Tab") moveSel(ref, 0, e.shiftKey ? -1 : 1);
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (cells[ref] == null) return;
      const next = { ...cells };
      delete next[ref];
      persist({ cells: next });
    } else beginEdit(ref, e.currentTarget.parentElement, typed ? e.key : undefined);
  };

  // Insert or delete whole rows/columns at the right-clicked cell; formulas follow their cells.
  const editLines = (axis: "row" | "col", at: number, count: number) => {
    setMenu(null);
    const size = axis === "row" ? rows : cols;
    persist({ cells: insertLines(cells, axis, at, count), [axis === "row" ? "rows" : "cols"]: size + count });
  };

  // Fill drag: pointer capture keeps events on the handle; the cell under the pointer sets the range.
  const cellUnder = (e: React.PointerEvent) =>
    (document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-cell]") as HTMLElement | null)?.dataset.cell ?? null;
  const fillHandlers = (src: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setFill(fillRange(src, src));
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!fill) return;
      const over = cellUnder(e);
      if (over && over in refsHere) setFill(fillRange(src, over));
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (fill && (fill.r0 !== fill.r1 || fill.c0 !== fill.c1)) persist({ cells: fillCells(cells, src, fill) });
      setFill(null);
    },
  });

  const cellBase = "border border-outline-variant min-w-[48px] max-w-[140px] h-[22px] px-1 text-xs align-middle";

  return (
    <div
      className={`group relative rounded-panel border bg-surface text-on-surface shadow-elev-1 ${selected ? "border-primary ring-2 ring-primary/40" : "border-outline-variant"}`}
      style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: "center" } as CSSProperties}
    >
      <NodeHandles />
      {selected && canEdit && <RotateHandle nodeId={id} />}
      {/* Clip the grid to the rounded corners here, not on the outer box: its handles and row/col buttons sit outside it. */}
      <div ref={gridRef} className="overflow-hidden rounded-[inherit] font-mono">
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
                const isSel = activeSel === ref && !isEditing;
                const inFill = !!fill && inRange(fill, r, c) && !isSel;
                return (
                  <td
                    key={c}
                    data-cell={ref}
                    className={`${cellBase} relative p-0${isSel ? " outline outline-2 -outline-offset-2 outline-primary" : ""}${inFill ? " bg-primary/10 outline outline-1 outline-dashed -outline-offset-1 outline-primary" : ""}`}
                  >
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
                          // Enter moves down and Tab moves across, like Excel; focus goes back to the grid either way.
                          if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            commit(ref);
                            if (e.key === "Enter") moveSel(ref, e.shiftKey ? -1 : 1, 0, true);
                            else moveSel(ref, 0, e.shiftKey ? -1 : 1, true);
                          } else if (e.key === "Escape") { e.preventDefault(); setEditing(null); focusCell(ref, true); }
                        }}
                      />
                    ) : (
                      <div
                        className={`nodrag nokey h-full w-full cursor-text overflow-hidden whitespace-nowrap px-1 leading-[22px] outline-none${varCells[ref] ? " gb-var" : ""}`}
                        title={cells[ref] && cells[ref] !== display[ref] ? cells[ref] : undefined}
                        tabIndex={canEdit ? -1 : undefined}
                        aria-label={canEdit ? `Cell ${ref}` : undefined}
                        onClick={() => canEdit && setSel(ref)}
                        onDoubleClick={(e) => beginEdit(ref, e.currentTarget.parentElement)}
                        onKeyDown={(e) => onCellKey(e, ref)}
                        onContextMenu={(e) => {
                          if (!canEdit) return;
                          e.preventDefault();
                          e.stopPropagation(); // ours, not the board's node menu
                          const r = e.currentTarget.getBoundingClientRect();
                          setSel(ref);
                          // A keyboard-opened menu (Shift+F10) has no pointer position, so place it under the cell.
                          setMenu({ ref, x: e.clientX || r.left, y: e.clientY || r.bottom });
                        }}
                      >
                        {display[ref] ?? ""}
                      </div>
                    )}
                    {isSel && (
                      <div
                        className="nodrag absolute bottom-0 right-0 z-10 h-[7px] w-[7px] cursor-crosshair border border-surface bg-primary"
                        title="Drag to fill"
                        aria-label={`Fill from ${ref}`}
                        {...fillHandlers(ref)}
                      />
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
      {menu && canEdit && createPortal(
        // The backdrop closes the menu on any click outside it.
        <div className="fixed inset-0 z-[1000]" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div
            role="menu"
            aria-label={`Rows and columns at ${menu.ref}`}
            className="fixed min-w-[180px] overflow-hidden rounded-control border border-outline-variant bg-surface-container py-1 text-xs text-on-surface shadow-elev-2"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); setMenu(null); focusCell(menu.ref, true); }
              else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
                const i = items.indexOf(document.activeElement as HTMLButtonElement);
                items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
              }
            }}
          >
            {(() => {
              const p = parseRef(menu.ref)!;
              return ([
                ["Insert row above", "row", p.row, 1, rows >= MAX_ROWS],
                ["Insert row below", "row", p.row + 1, 1, rows >= MAX_ROWS],
                ["Insert column left", "col", p.col, 1, cols >= MAX_COLS],
                ["Insert column right", "col", p.col + 1, 1, cols >= MAX_COLS],
                ["Delete row", "row", p.row, -1, rows <= 1],
                ["Delete column", "col", p.col, -1, cols <= 1],
              ] as const).map(([label, axis, at, count, disabled], i) => (
                <button
                  key={label}
                  role="menuitem"
                  autoFocus={i === 0}
                  disabled={disabled}
                  className={`block w-full px-3 py-1 text-left hover:bg-primary/10 focus:bg-primary/10 focus:outline-none disabled:opacity-40${i === 4 ? " mt-1 border-t border-outline-variant pt-1.5" : ""}`}
                  onClick={() => { editLines(axis, at, count); focusCell(menu.ref, true); }}
                >
                  {label}
                </button>
              ));
            })()}
          </div>
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
