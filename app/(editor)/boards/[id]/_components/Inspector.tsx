"use client";

import { useEffect, useRef, useState } from "react";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { Type, Image as ImageIcon, Palette, Link2, Spline, ArrowLeftRight, type LucideIcon } from "lucide-react";
import { useCanvasStore } from "../_store/canvasStore";
import { swapEdgeEnds, updateEdgeLabel, updateEdgeStyle, updateNodeData } from "../actions";

type NodeData = {
  alt?: string;
  notes?: string;
  icons?: string[];
  tags?: string[];
  url?: string;
  title?: string;
  image?: string;
  varText?: string;
  showVars?: boolean;
  align?: "left" | "center" | "right";
  fontSize?: number;
  fontFamily?: "sans" | "serif" | "mono";
};

export function Inspector({
  boardId,
  node,
  edge,
}: {
  boardId: string;
  node: Node | null;
  edge: Edge | null;
}) {
  if (node) return <NodeInspector key={node.id} boardId={boardId} node={node} />;
  if (edge && !edge.id.startsWith("tree:")) return <EdgeInspector key={edge.id} boardId={boardId} edge={edge} />;
  return null;
}

function Panel({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <aside className="gb-pop-in pointer-events-auto absolute right-3 top-[5.25rem] z-20 flex max-h-[80vh] w-64 flex-col overflow-hidden rounded-panel border border-outline-variant bg-surface-container/97 text-on-surface shadow-elev-3 backdrop-blur max-sm:left-3 max-sm:w-auto max-sm:max-h-[55vh]">
      <div className="flex items-center gap-1.5 border-b border-outline-variant px-3 py-2 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
        <Icon size={14} />
        <span>{title}</span>
      </div>
      <div className="overflow-y-auto p-3">{children}</div>
    </aside>
  );
}

const NODE_ICON: Record<string, LucideIcon> = { text: Type, image: ImageIcon, swatch: Palette, link: Link2 };

function NodeInspector({ boardId, node }: { boardId: string; node: Node }) {
  const setData = useCanvasStore((s) => s.updateNodeData);
  const d = (node.data ?? {}) as NodeData;
  const [notes, setNotes] = useState(d.notes ?? "");
  const [tags, setTags] = useState((d.tags ?? []).join(", "));
  const [icons, setIcons] = useState<string[]>(d.icons ?? []);
  const [iconInput, setIconInput] = useState("");
  const [alt, setAlt] = useState(d.alt ?? "");
  const [linkUrl, setLinkUrl] = useState(d.url ?? "");
  const [linkTitle, setLinkTitle] = useState(d.title ?? "");
  const [linkImage, setLinkImage] = useState(d.image ?? "");
  const [varText, setVarText] = useState(d.varText ?? "");
  const [showVars, setShowVars] = useState(d.showVars ?? false);
  const [align, setAlign] = useState<"left" | "center" | "right">(d.align ?? "left");
  const [fontFamily, setFontFamily] = useState<"sans" | "serif" | "mono">(d.fontFamily ?? "sans");
  const [fontSize, setFontSize] = useState<number>(typeof d.fontSize === "number" ? d.fontSize : 14);

  const commit = (patch: Partial<NodeData>) => {
    setData(node.id, patch as Record<string, unknown>);
    void updateNodeData(boardId, node.id, patch as Record<string, unknown>);
  };
  // URL is schema-validated server-side (must be a valid URL), so only commit a parseable one.
  const commitUrl = () => {
    const u = linkUrl.trim();
    if (u && URL.canParse(u)) commit({ url: u });
  };
  const commitTags = () => commit({ tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
  const addIcon = () => {
    const v = iconInput.trim();
    if (!v) return;
    const next = [...icons, v].slice(0, 24);
    setIcons(next);
    setIconInput("");
    commit({ icons: next });
  };

  return (
    <Panel title={`${node.type} node`} icon={NODE_ICON[node.type as string] ?? Type}>
      <label className="mb-1 block text-[11px] text-on-surface-variant">Icons / emoji</label>
      <div className="mb-1 flex flex-wrap gap-1">
        {icons.map((ic, i) => (
          <button
            key={i}
            onClick={() => {
              const next = icons.filter((_, j) => j !== i);
              setIcons(next);
              commit({ icons: next });
            }}
            className="rounded bg-surface-variant px-1 text-sm"
            title="Remove"
          >
            {ic}
          </button>
        ))}
      </div>
      <input
        value={iconInput}
        onChange={(e) => setIconInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addIcon())}
        placeholder="emoji + Enter (🚀)"
        className="mb-3 w-full rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
      />

      {node.type === "text" && (
        <div className="mb-1">
          <label className="mb-1 block text-[11px] text-on-surface-variant">Alignment</label>
          <Seg
            value={align}
            onChange={(v) => { setAlign(v); commit({ align: v }); }}
            options={[{ v: "left", label: "Left" }, { v: "center", label: "Center" }, { v: "right", label: "Right" }]}
          />
          <label className="mb-1 block text-[11px] text-on-surface-variant">Font</label>
          <Seg
            value={fontFamily}
            onChange={(v) => { setFontFamily(v); commit({ fontFamily: v }); }}
            options={[{ v: "sans", label: "Sans" }, { v: "serif", label: "Serif" }, { v: "mono", label: "Mono" }]}
          />
          <div className="mb-3 flex items-center gap-2">
            <label className="text-[11px] text-on-surface-variant">Size</label>
            <input
              type="range"
              min={10}
              max={48}
              step={1}
              value={fontSize}
              // live preview via the store; persist once on release so a drag isn't dozens of saves
              onChange={(e) => { const n = Number(e.target.value); setFontSize(n); setData(node.id, { fontSize: n }); }}
              onPointerUp={(e) => void updateNodeData(boardId, node.id, { fontSize: Number((e.target as HTMLInputElement).value) })}
              className="flex-1 accent-primary"
            />
            <span className="w-8 text-right text-[11px] tabular-nums text-on-surface-variant">{fontSize}px</span>
          </div>
        </div>
      )}

      {node.type === "image" && (
        <>
          <label className="mb-1 block text-[11px] text-on-surface-variant">Alt text</label>
          <input
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            onBlur={() => commit({ alt })}
            className="mb-3 w-full rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
          />
        </>
      )}

      {node.type === "link" && (
        <>
          <label className="mb-1 block text-[11px] text-on-surface-variant">Title</label>
          <input
            value={linkTitle}
            onChange={(e) => setLinkTitle(e.target.value)}
            onBlur={() => commit({ title: linkTitle.trim() || undefined })}
            placeholder="Card title (overrides the preview)"
            className="mb-3 w-full rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
          />

          <label className="mb-1 block text-[11px] text-on-surface-variant">Image URL</label>
          <input
            value={linkImage}
            onChange={(e) => setLinkImage(e.target.value)}
            onBlur={() => commit({ image: linkImage.trim() || undefined })}
            placeholder="Paste an image URL from the site"
            className="mb-2 w-full rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
          />
          {linkImage.trim() && (
            // eslint-disable-next-line @next/next/no-img-element -- external thumbnail preview
            <img
              src={linkImage.trim()}
              alt=""
              className="mb-3 h-20 w-full rounded-control border border-outline-variant object-cover"
              onError={(e) => ((e.currentTarget.style.display = "none"))}
            />
          )}

          <label className="mb-1 block text-[11px] text-on-surface-variant">Link URL</label>
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onBlur={commitUrl}
            placeholder="https://…"
            className="mb-3 w-full rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
          />
          <p className="mb-3 -mt-2 text-[10px] text-on-surface-variant">Tip: double-click the card to open it.</p>
        </>
      )}

      <label className="mb-1 block text-[11px] text-on-surface-variant">Notes (Markdown)</label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => commit({ notes })}
        rows={4}
        placeholder="Hidden long-form notes…"
        className="mb-3 w-full resize-none rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
      />

      <label className="mb-1 block text-[11px] text-on-surface-variant">Tags (comma-separated)</label>
      <input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        onBlur={commitTags}
        placeholder="reference, hero, v2"
        className="w-full rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
      />

      <div className="mt-4 border-t border-outline-variant pt-3">
        <label className="mb-1 block text-[11px] text-on-surface-variant">Variables</label>
        <textarea
          value={varText}
          onChange={(e) => setVarText(e.target.value)}
          onBlur={() => commit({ varText: varText.slice(0, 500) })}
          rows={2}
          placeholder="$PricePer($40) • $UnitsReq(10)"
          className="mb-1 w-full resize-none rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
        />
        <p className="mb-2 text-[10px] leading-snug text-on-surface-variant">
          Write <code className="rounded bg-surface-variant px-1">$name(value)</code> tokens — e.g.{" "}
          <code className="rounded bg-surface-variant px-1">$cost(30)</code>. The number is tracked board-wide;
          the value shows verbatim. Text between tokens is kept as-is.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-on-surface-variant">
          <input
            type="checkbox"
            checked={showVars}
            onChange={(e) => {
              const v = e.target.checked;
              setShowVars(v);
              commit({ showVars: v });
            }}
            className="accent-primary"
          />
          Show on node
        </label>
      </div>
    </Panel>
  );
}

type EdgeStyle = {
  color?: string;
  width?: number;
  lineStyle?: "flow" | "solid" | "dashed" | "dotted";
  routing?: "avoid" | "bezier" | "smoothstep" | "step" | "straight";
  avoidStyle?: "snake" | "curve";
  anchor?: "auto" | "fixed";
  waypoints?: { x: number; y: number }[];
  stub?: number;
  arrow?: "none" | "start" | "end" | "both";
  flowSpeed?: number;
};

function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="mb-3 flex overflow-hidden rounded-control border border-outline-variant">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`flex-1 px-1.5 py-1 text-xs transition-colors ${
            value === o.v ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-variant"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EdgeInspector({ boardId, edge }: { boardId: string; edge: Edge }) {
  const updateEdge = useCanvasStore((s) => s.updateEdge);
  const d = (edge.data ?? {}) as EdgeStyle;
  const [label, setLabel] = useState(typeof edge.label === "string" ? edge.label : "");
  const [style, setStyle] = useState<EdgeStyle>({
    color: d.color ?? "#8b5cf6",
    width: d.width ?? 2,
    lineStyle: d.lineStyle ?? "flow",
    routing: d.routing ?? "avoid",
    avoidStyle: d.avoidStyle ?? "snake",
    anchor: d.anchor ?? "fixed",
    stub: d.stub ?? 32,
    arrow: d.arrow ?? "end",
    flowSpeed: d.flowSpeed ?? 1,
  });

  // Debounced persistence: the store update is immediate (live preview); the server action +
  // full-board cache bust is coalesced (color/width sliders fire many times per drag).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ data: Record<string, unknown>; animated: boolean } | null>(null);
  const flush = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (pending.current) {
      void updateEdgeStyle(boardId, edge.id, pending.current);
      pending.current = null;
    }
  };
  useEffect(() => () => flush(), []); // flush on unmount / selection change (key=edge.id remounts)

  const apply = (patch: Partial<EdgeStyle>) => {
    const next = { ...style, ...patch };
    setStyle(next);
    const color = next.color ?? "#8b5cf6";
    const marker = { type: MarkerType.ArrowClosed, color, width: 16, height: 16 };
    const a = next.arrow ?? "end";
    const animated = false; // AnimatedEdge animates itself (comet); RF's built-in animation is off
    updateEdge(edge.id, {
      data: patch,
      animated,
      markerEnd: a === "end" || a === "both" ? marker : undefined,
      markerStart: a === "start" || a === "both" ? marker : undefined,
    });
    pending.current = { data: { ...(pending.current?.data ?? {}), ...patch }, animated };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 300);
  };

  // Swap which node/anchor is the source vs the target (flips the connector end-for-end).
  const swap = () => {
    updateEdge(edge.id, {
      source: edge.target,
      target: edge.source,
      sourceHandle: edge.targetHandle,
      targetHandle: edge.sourceHandle,
    });
    void swapEdgeEnds(boardId, edge.id);
  };

  return (
    <Panel title="Connector" icon={Spline}>
      <button
        onClick={swap}
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-control border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98]"
        title="Swap source and target ends"
      >
        <ArrowLeftRight size={14} /> Swap source &amp; target
      </button>

      <label className="mb-1 block text-[11px] text-on-surface-variant">Anchor</label>
      <Seg
        value={style.anchor ?? "fixed"}
        onChange={(v) => apply({ anchor: v })}
        options={[
          { v: "fixed", label: "Fixed" },
          { v: "auto", label: "Auto" },
        ]}
      />
      {(style.anchor ?? "fixed") === "auto" && (
        <p className="mb-3 -mt-2 text-[10px] text-on-surface-variant">Ends slide around each node, always facing the other end.</p>
      )}

      {(d.waypoints?.length ?? 0) > 0 && (
        <button
          onClick={() => {
            updateEdge(edge.id, { data: { waypoints: [] } });
            void updateEdgeStyle(boardId, edge.id, { data: { waypoints: [] } });
          }}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-control border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98]"
          title="Remove all manual bends and return to auto-routing"
        >
          Clear bends ({d.waypoints?.length})
        </button>
      )}

      <label className="mb-1 block text-[11px] text-on-surface-variant">Direction</label>
      <Seg
        value={style.arrow ?? "end"}
        onChange={(v) => apply({ arrow: v })}
        options={[
          { v: "none", label: "—" },
          { v: "start", label: "←" },
          { v: "end", label: "→" },
          { v: "both", label: "↔" },
        ]}
      />

      <label className="mb-1 block text-[11px] text-on-surface-variant">Line type</label>
      <Seg
        value={style.lineStyle ?? "flow"}
        onChange={(v) => apply({ lineStyle: v })}
        options={[
          { v: "flow", label: "Flow" },
          { v: "solid", label: "Solid" },
          { v: "dashed", label: "Dashed" },
          { v: "dotted", label: "Dotted" },
        ]}
      />

      <label className="mb-1 block text-[11px] text-on-surface-variant">Routing</label>
      <Seg
        value={style.routing ?? "avoid"}
        onChange={(v) => apply({ routing: v })}
        options={[
          { v: "avoid", label: "Avoid" },
          { v: "bezier", label: "Curve" },
          { v: "smoothstep", label: "Elbow" },
          { v: "step", label: "Step" },
          { v: "straight", label: "Line" },
        ]}
      />
      {(style.routing ?? "avoid") === "avoid" && (
        <>
          <p className="mb-2 -mt-2 text-[10px] text-on-surface-variant">Curves normally; bends around any node in its way.</p>
          <label className="mb-1 block text-[11px] text-on-surface-variant">Detour shape</label>
          <Seg
            value={style.avoidStyle ?? "snake"}
            onChange={(v) => apply({ avoidStyle: v })}
            options={[
              { v: "snake", label: "Snake" },
              { v: "curve", label: "Curve" },
            ]}
          />
          <div className="mb-3 flex items-center gap-2">
            <label className="text-[11px] text-on-surface-variant">Approach</label>
            <input
              type="range"
              min={16}
              max={64}
              step={4}
              value={style.stub ?? 32}
              onChange={(e) => apply({ stub: Number(e.target.value) })}
              className="flex-1 accent-primary"
              title="How far the line runs straight into/out of a node before it turns"
            />
            <span className="w-7 text-right text-[11px] tabular-nums text-on-surface-variant">{style.stub ?? 32}px</span>
          </div>
        </>
      )}

      <div className="mb-3 flex items-center gap-2">
        <label className="text-[11px] text-on-surface-variant">Color</label>
        <input
          type="color"
          value={style.color ?? "#8b5cf6"}
          onChange={(e) => apply({ color: e.target.value })}
          className="h-7 w-9 cursor-pointer rounded border border-outline-variant bg-surface"
        />
        <label className="ml-2 text-[11px] text-on-surface-variant">Width</label>
        <input
          type="range"
          min={1}
          max={8}
          step={1}
          value={style.width ?? 2}
          onChange={(e) => apply({ width: Number(e.target.value) })}
          className="flex-1 accent-primary"
        />
        <span className="w-4 text-right text-[11px] tabular-nums text-on-surface-variant">{style.width ?? 2}</span>
      </div>

      {(style.lineStyle ?? "flow") === "flow" && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <label className="text-[11px] text-on-surface-variant">Flow speed</label>
            <input
              type="range"
              min={0.25}
              max={3}
              step={0.25}
              value={style.flowSpeed ?? 1}
              onChange={(e) => apply({ flowSpeed: Number(e.target.value) })}
              className="flex-1 accent-primary"
            />
            <span className="w-7 text-right text-[11px] tabular-nums text-on-surface-variant">{(style.flowSpeed ?? 1).toFixed(2)}×</span>
          </div>
        </>
      )}

      <label className="mb-1 block text-[11px] text-on-surface-variant">Label</label>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => {
          updateEdge(edge.id, { label: label || undefined });
          void updateEdgeLabel(boardId, edge.id, label);
        }}
        placeholder="flows to…"
        className="w-full rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm outline-none focus-visible:border-primary"
      />
    </Panel>
  );
}
