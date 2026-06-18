"use client";

import { useState } from "react";
import { Tags, Group as GroupIcon, X, Crosshair, Trash2, Plus } from "lucide-react";
import type { GroupDTO } from "@/app/lib/tag-actions";

type Props = {
  tags: { tag: string; count: number }[];
  groups: GroupDTO[];
  activeTag: string;
  selectionCount: number;
  onSelectTag: (tag: string) => void;
  onClearTag: () => void;
  onClose: () => void;
  onCreateGroup: () => void;
  onTagSelection: () => void;
  onUpdateGroup: (id: string, patch: { label?: string | null; color?: string | null; tags?: string[] }) => void;
  onDeleteGroup: (id: string) => void;
  onAddSelectionToGroup: (id: string) => void;
  onFocusGroup: (id: string) => void;
};

// Searchable tag + group browser. Lives on the LEFT so it doesn't collide with the Inspector.
export function TagPanel(props: Props) {
  const { tags, groups, activeTag, selectionCount } = props;
  const [q, setQ] = useState("");
  const shown = q ? tags.filter((t) => t.tag.toLowerCase().includes(q.toLowerCase())) : tags;

  return (
    <aside className="gb-pop-in pointer-events-auto absolute left-3 top-[5.25rem] z-20 flex max-h-[80vh] w-64 flex-col overflow-hidden rounded-panel border border-outline-variant bg-surface-container/97 text-on-surface shadow-elev-3 backdrop-blur max-sm:right-3 max-sm:w-auto max-sm:max-h-[55vh]">
      <div className="flex items-center justify-between border-b border-outline-variant px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          <Tags size={14} /> Tags &amp; groups
        </span>
        <button onClick={props.onClose} aria-label="Close" className="rounded p-0.5 text-on-surface-variant transition hover:bg-surface-variant">
          <X size={15} />
        </button>
      </div>

      <div className="overflow-y-auto p-3">
        {/* selection actions */}
        <div className="mb-3 flex flex-col gap-1.5">
          <button
            onClick={props.onTagSelection}
            disabled={selectionCount === 0}
            className="flex items-center gap-1.5 rounded-control border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface transition hover:bg-surface-variant active:scale-[.98] disabled:opacity-40"
          >
            <Tags size={14} /> Tag selection{selectionCount ? ` (${selectionCount})` : ""}
          </button>
          <button
            onClick={props.onCreateGroup}
            disabled={selectionCount === 0}
            className="flex items-center gap-1.5 rounded-control border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface transition hover:bg-surface-variant active:scale-[.98] disabled:opacity-40"
          >
            <GroupIcon size={14} /> Group selection into a cloud{selectionCount ? ` (${selectionCount})` : ""}
          </button>
          {selectionCount === 0 && <p className="text-[11px] text-on-surface-variant">Select nodes to tag or group them.</p>}
        </div>

        {/* tag list */}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">Tags ({tags.length})</span>
          {activeTag && (
            <button onClick={props.onClearTag} className="text-[11px] text-primary hover:underline">
              clear filter
            </button>
          )}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tags…"
          className="mb-2 w-full rounded-control border border-outline-variant bg-surface px-2 py-1 text-xs text-on-surface outline-none focus-visible:border-primary"
        />
        {shown.length === 0 ? (
          <p className="mb-3 text-[11px] text-on-surface-variant">No tags yet. Tag a node, branch, or selection.</p>
        ) : (
          <div className="mb-3 flex flex-wrap gap-1">
            {shown.map((t) => (
              <button
                key={t.tag}
                onClick={() => props.onSelectTag(t.tag)}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition ${
                  activeTag === t.tag
                    ? "bg-primary text-on-primary"
                    : "bg-secondary-container text-on-secondary-container hover:opacity-80"
                }`}
                title={`Filter & jump to #${t.tag}`}
              >
                #{t.tag}
                <span className="tabular-nums opacity-70">{t.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* groups */}
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">Groups ({groups.length})</div>
        {groups.length === 0 ? (
          <p className="text-[11px] text-on-surface-variant">No groups. Select nodes → “Group into a cloud”.</p>
        ) : (
          <ul className="space-y-2">
            {groups.map((g) => (
              <GroupRow key={g.id} group={g} {...props} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function GroupRow({
  group,
  onUpdateGroup,
  onDeleteGroup,
  onAddSelectionToGroup,
  onFocusGroup,
  selectionCount,
}: { group: GroupDTO } & Pick<
  Props,
  "onUpdateGroup" | "onDeleteGroup" | "onAddSelectionToGroup" | "onFocusGroup" | "selectionCount"
>) {
  const [label, setLabel] = useState(group.label ?? "");
  const [tagInput, setTagInput] = useState("");
  const [color, setColor] = useState(group.color ?? "#8b5cf6");

  return (
    <li className="rounded-control border border-outline-variant bg-surface p-2">
      <div className="mb-1 flex items-center gap-1.5">
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          onBlur={() => color !== (group.color ?? "#8b5cf6") && onUpdateGroup(group.id, { color })}
          className="h-5 w-5 shrink-0 cursor-pointer rounded border border-outline-variant bg-surface"
          title="Cloud color"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => onUpdateGroup(group.id, { label: label || null })}
          placeholder="Untitled group"
          className="min-w-0 flex-1 rounded bg-transparent px-1 text-xs font-medium text-on-surface outline-none focus-visible:bg-surface-variant"
        />
        <button onClick={() => onFocusGroup(group.id)} title="Fit view to this group" className="rounded p-1 text-on-surface-variant transition hover:bg-surface-variant">
          <Crosshair size={13} />
        </button>
        <button onClick={() => onDeleteGroup(group.id)} title="Delete group" className="rounded p-1 text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container">
          <Trash2 size={13} />
        </button>
      </div>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {group.tags.map((t) => (
          <button
            key={t}
            onClick={() => onUpdateGroup(group.id, { tags: group.tags.filter((x) => x !== t) })}
            className="rounded bg-secondary-container px-1.5 py-0.5 text-[10px] text-on-secondary-container hover:line-through"
            title="Remove tag"
          >
            #{t}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tagInput.trim()) {
              onUpdateGroup(group.id, { tags: [...new Set([...group.tags, tagInput.trim()])] });
              setTagInput("");
            }
          }}
          placeholder="add tag + Enter"
          className="min-w-0 flex-1 rounded border border-outline-variant bg-surface px-1.5 py-0.5 text-[11px] text-on-surface outline-none focus-visible:border-primary"
        />
        <span className="shrink-0 text-[10px] tabular-nums text-on-surface-variant">{group.nodeIds.length} nodes</span>
        <button
          onClick={() => onAddSelectionToGroup(group.id)}
          disabled={selectionCount === 0}
          title="Add selected nodes to this group"
          className="rounded p-1 text-on-surface-variant transition hover:bg-surface-variant disabled:opacity-40"
        >
          <Plus size={13} />
        </button>
      </div>
    </li>
  );
}
