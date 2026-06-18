import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// In-app AI (feature parity): text → mind-map, expand-node, summarize. Self-hostable + optional —
// everything is gated on ANTHROPIC_API_KEY, so a self-host with no key simply hides AI features.
// Model is overridable via AI_MODEL (default: the most capable Claude). Set AI_MODEL=claude-sonnet-4-6
// for faster/cheaper interactive use.

const MODEL = process.env.AI_MODEL || "claude-opus-4-8";

export function isAIEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("AI is not configured (set ANTHROPIC_API_KEY).");
  return new Anthropic({ apiKey });
}

// Pull the validated input object out of the forced tool_use block.
function toolInput(msg: Anthropic.Message): unknown {
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("AI returned no structured output.");
  return block.input;
}

export type AIMindMapNode = { id: string; parent: string | null; label: string };

/** Generate a small mind-map (one root + descendants) from a free-text prompt. */
export async function generateMindMap(prompt: string): Promise<AIMindMapNode[]> {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system:
      "You are a mind-mapping assistant. Given a topic, produce a concise, well-structured mind-map. " +
      "Emit 8–20 nodes total: exactly one root (parent=null) and the rest organized 2–3 levels deep. " +
      "Labels are short (≤ 60 chars), specific, no trailing punctuation. ids are short unique slugs.",
    tools: [
      {
        name: "emit_mindmap",
        description: "Return the generated mind-map as a flat node list with parent references.",
        input_schema: {
          type: "object",
          properties: {
            nodes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "short unique slug" },
                  parent: { type: ["string", "null"], description: "parent id, or null for the single root" },
                  label: { type: "string", description: "node text, ≤ 60 chars" },
                },
                required: ["id", "label"],
              },
            },
          },
          required: ["nodes"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "emit_mindmap" },
    messages: [{ role: "user", content: `Build a mind-map about: ${prompt}` }],
  });

  const input = toolInput(res) as { nodes?: Array<{ id?: unknown; parent?: unknown; label?: unknown }> };
  const raw = Array.isArray(input.nodes) ? input.nodes : [];
  const nodes: AIMindMapNode[] = raw
    .filter((n) => typeof n.id === "string" && typeof n.label === "string")
    .map((n) => ({
      id: String(n.id),
      parent: typeof n.parent === "string" ? n.parent : null,
      label: String(n.label).slice(0, 120),
    }));
  if (nodes.length === 0) throw new Error("AI produced no nodes.");
  // Guarantee at least one root: if none has null parent, promote the first.
  if (!nodes.some((n) => n.parent === null)) nodes[0].parent = null;
  // Drop dangling parents (point them at root) to keep the tree valid.
  const ids = new Set(nodes.map((n) => n.id));
  const root = nodes.find((n) => n.parent === null)!;
  for (const n of nodes) if (n.parent && !ids.has(n.parent)) n.parent = root.id;
  // Break cycles / re-attach orphans: anything not reachable from the root (e.g. a→b→a) would be
  // silently dropped by the BFS insert in ai-actions; reparent it to root so nothing is lost.
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) if (n.parent) (childrenOf.get(n.parent) ?? childrenOf.set(n.parent, []).get(n.parent)!).push(n.id);
  const reachable = new Set<string>([root.id]);
  const stack = [root.id];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of childrenOf.get(id) ?? []) if (!reachable.has(c)) { reachable.add(c); stack.push(c); }
  }
  for (const n of nodes) if (n.id !== root.id && !reachable.has(n.id)) n.parent = root.id;
  return nodes;
}

/** Expand a node into a handful of concise child ideas. */
export async function expandNodeIdeas(label: string, siblingContext: string[]): Promise<string[]> {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 600,
    system:
      "You expand a single mind-map node into 4–7 concise child ideas. Each child is short (≤ 60 chars), " +
      "specific, and distinct from the existing children. No numbering, no trailing punctuation.",
    tools: [
      {
        name: "emit_children",
        description: "Return the child idea labels.",
        input_schema: {
          type: "object",
          properties: { children: { type: "array", items: { type: "string" } } },
          required: ["children"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "emit_children" },
    messages: [
      {
        role: "user",
        content:
          `Node: "${label}".` +
          (siblingContext.length ? ` Existing children: ${siblingContext.join("; ")}.` : "") +
          " Suggest new child ideas.",
      },
    ],
  });
  const input = toolInput(res) as { children?: unknown };
  const children = Array.isArray(input.children) ? input.children : [];
  return children.filter((c): c is string => typeof c === "string").map((c) => c.slice(0, 120)).slice(0, 7);
}

/** Summarize a set of node texts into a short Markdown summary. */
export async function summarizeTexts(texts: string[]): Promise<string> {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 700,
    system:
      "You summarize a cluster of mind-map / moodboard notes into a tight Markdown summary: a one-line " +
      "headline (## ), then 3–6 bullet takeaways. Be concrete and faithful to the input; do not invent.",
    messages: [{ role: "user", content: `Summarize these notes:\n\n${texts.map((t) => `- ${t}`).join("\n")}` }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}
