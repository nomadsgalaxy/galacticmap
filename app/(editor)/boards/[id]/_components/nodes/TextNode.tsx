"use client";

import { memo, useEffect, useMemo, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { NodeResizer, useStore, type NodeProps } from "@xyflow/react";
import { NodeHandles } from "./NodeHandles";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { useCanvasStore } from "../../_store/canvasStore";
import { updateNodeData } from "../../actions";
import { RotateHandle } from "./RotateHandle";
import { VAR_DEF_RE, parseVarValue } from "../../../../../lib/variables";

// Hoisted so they're stable identities (no new array/object per render).
const REMARK_PLUGINS = [remarkGfm];
// Allow inline HTML in text nodes, but SANITIZE it (node text can include guest-suggested content,
// so raw HTML would be an XSS hole). Start from rehype's safe GitHub schema + a few extra
// formatting tags; scripts, event handlers, and javascript: URLs are still stripped.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "mark", "sub", "sup", "kbd", "abbr", "ins", "details", "summary", "span", "div", "small", "u",
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Allow the Discord spoiler span (class="gb-spoiler") and the tracked-variable span
    // (class="gb-var" + data-var) so ||spoiler|| and $name(value) render + style safely.
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", "gb-spoiler", "gb-var"],
      "data-var",
    ],
  },
};

// Escape any HTML-special characters in a value so the injected span can't smuggle markup.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Substitute each $name(content) VARIABLE token with a styled inline span showing the content VERBATIM
// (e.g. $PricePer($40) → "$40", $UnitsReq(10) → "10"). The editor keeps the RAW token; only this VIEW
// transform swaps in the span. A token is a variable iff its content holds a number (parseVarValue);
// non-numeric $name(...) tokens are NOT variables and stay literal text.
function renderVarTokens(source: string): string {
  return source.replace(VAR_DEF_RE, (m, name: string, content: string) => {
    if (parseVarValue(content) === null) return m;
    return `<span class="gb-var" data-var="${escapeHtml(name)}">${escapeHtml(content)}</span>`;
  });
}
const REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]] as const;
const MD_COMPONENTS = {
  a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer nofollow" />,
};

// WYSIWYG markdown editor (TipTap). Lazy + client-only so it never ships to the read-only/public board
// and doesn't run during SSR.
const MarkdownEditor = dynamic(() => import("./MarkdownEditor"), { ssr: false });

// Shared Markdown renderer — used both for the committed node text and the live edit preview.
function MarkdownView({ source }: { source: string }) {
  return (
    <div className="gb-md break-words">
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype plugin tuple typing */}
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS as any} components={MD_COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

export const TextNode = memo(function TextNode({ id, data, selected }: NodeProps) {
  // "Resized" = the node has an EXPLICIT width/height. Read it from the store's nodeLookup, NOT from
  // NodeProps.width — that's the MEASURED size (always a number), which would mark every node as sized.
  // Un-resized nodes keep the default min-160/max-280 clamp (a good default for quick text boxes); once
  // the user drags a resize handle, explicit dims are set and the node fills/stretches to that box.
  const sized = useStore((s) => { const n = s.nodeLookup.get(id); return typeof n?.width === "number" && typeof n?.height === "number"; });
  const text = String((data as { text?: string }).text ?? "");
  const rotation = Number((data as { rotation?: number }).rotation ?? 0);
  // Per-node text formatting (alignment / size / family). Family uses LITERAL Tailwind classes so the
  // utility survives purge; size + align are inline styles inherited by both the rendered view and editor.
  const align = (data as { align?: "left" | "center" | "right" }).align;
  const fontSize = (data as { fontSize?: number }).fontSize;
  const fontFamily = (data as { fontFamily?: "sans" | "serif" | "mono" }).fontFamily;
  const familyClass = fontFamily === "serif" ? "font-serif" : fontFamily === "mono" ? "font-mono" : "font-sans";
  // --gb-font-size drives the .gb-md committed view (its children are em-relative); fontSize covers the
  // editor/placeholder which inherit normally. align inherits straight through (.gb-md sets no text-align).
  const contentStyle = {
    textAlign: align,
    ...(fontSize ? { fontSize: `${fontSize}px`, "--gb-font-size": `${fontSize}px` } : {}),
  } as CSSProperties;
  const icons = ((data as { icons?: string[] }).icons ?? []) as string[];
  const hasNotes = !!(data as { notes?: string }).notes;
  const boardId = useCanvasStore((s) => s.boardId);
  const canEdit = useCanvasStore((s) => s.canEdit);
  const setData = useCanvasStore((s) => s.updateNodeData);
  const editingNodeId = useCanvasStore((s) => s.editingNodeId);
  const setEditingNode = useCanvasStore((s) => s.setEditingNode);

  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(text);

  useEffect(() => setVal(text), [text]);
  // A just-created text box (e.g. from a connect-arrow or "Add text") opens focused & ready to type.
  useEffect(() => {
    if (editingNodeId === id && canEdit) {
      setEditing(true);
      setEditingNode(null);
    }
  }, [editingNodeId, id, canEdit, setEditingNode]);

  // Memoize the parsed Markdown on `text` so drag-frame re-renders (which churn the node's data
  // identity) don't re-parse Markdown for every visible text node.
  const rendered = useMemo(() => <MarkdownView source={renderVarTokens(text)} />, [text]);

  const commit = () => {
    setEditing(false);
    if (val !== text) {
      setData(id, { text: val });
      void updateNodeData(boardId, id, { text: val });
    }
  };

  return (
    <div
      onDoubleClick={() => canEdit && setEditing(true)}
      style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: "center" }}
      className={`group rounded-panel border bg-surface px-3 py-2 text-sm text-on-surface shadow-elev-1 ${
        sized ? "flex flex-col h-full w-full overflow-hidden" : "min-w-[160px] max-w-[280px]"
      } ${selected ? "border-primary ring-2 ring-primary/40" : "border-outline-variant"}`}
    >
      {/* Drag the corners/edges to size the node; while selected the resizer owns the perimeter so the
          connection anchors yield to it (mirrors ImageNode). */}
      <NodeResizer isVisible={!!selected && canEdit} minWidth={120} minHeight={48} />
      <NodeHandles selected={!!selected && canEdit} />
      {selected && canEdit && <RotateHandle nodeId={id} />}
      {(icons.length > 0 || hasNotes) && (
        <div className="mb-1 flex items-center gap-1 text-sm">
          {icons.map((ic, i) => (
            <span key={i}>{ic}</span>
          ))}
          {hasNotes && <span className="ml-auto text-xs text-on-surface-variant" title="Has notes">📝</span>}
        </div>
      )}
      <div className={`${familyClass} ${sized ? "min-h-0 flex-1 overflow-auto" : ""}`} style={contentStyle}>
        {editing ? (
          <MarkdownEditor value={text} onChange={setVal} onDone={commit} />
        ) : text ? (
          rendered
        ) : (
          <span className="text-on-surface-variant">Double-click to edit (Markdown)</span>
        )}
      </div>
    </div>
  );
});
