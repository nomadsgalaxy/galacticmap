"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Bold from "@tiptap/extension-bold";
import Underline from "@tiptap/extension-underline";
import { Mark, markInputRule, markPasteRule } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";

// ── Discord-flavored markdown marks ──────────────────────────────────────────────────────────────
// Discord reassigns "__" from bold (standard markdown) to UNDERLINE, and adds "||spoiler||". So:
//   **bold**  *italic* / _italic_  __underline__  ~~strike~~  `code`  ||spoiler||
// Bold is reconfigured to claim only "**" (freeing "__" for underline). Underline/Spoiler round-trip as
// HTML (<u>, <span data-spoiler>) which the sanitized renderer already displays.
const starBoldInput = /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/;
const starBoldPaste = /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))/g;
const DiscordBold = Bold.extend({
  addInputRules() {
    return [markInputRule({ find: starBoldInput, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: starBoldPaste, type: this.type })];
  },
});

const underlineInput = /(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))$/;
const underlinePaste = /(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))/g;
const DiscordUnderline = Underline.extend({
  addInputRules() {
    return [markInputRule({ find: underlineInput, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: underlinePaste, type: this.type })];
  },
});

const spoilerInput = /(?:^|\s)(\|\|(?!\s+\|\|)((?:[^|]+))\|\|(?!\s+\|\|))$/;
const spoilerPaste = /(?:^|\s)(\|\|(?!\s+\|\|)((?:[^|]+))\|\|(?!\s+\|\|))/g;
const Spoiler = Mark.create({
  name: "spoiler",
  parseHTML() {
    return [{ tag: "span[data-spoiler]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, "data-spoiler": "true", class: "gb-spoiler" }, 0];
  },
  addInputRules() {
    return [markInputRule({ find: spoilerInput, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: spoilerPaste, type: this.type })];
  },
});

// Inline WYSIWYG markdown editor for text nodes: typing "# " makes a heading, "**x**" bolds, "__x__"
// underlines (Discord), "||x||" spoilers, "- " starts a list, etc. Storage stays markdown (HTML for the
// Discord-only marks). Lazy-loaded so it never ships to the read-only/public board.
export default function MarkdownEditor({
  value,
  onChange,
  onDone,
}: {
  value: string;
  onChange: (markdown: string) => void;
  onDone: () => void;
}) {
  const editor = useEditor({
    immediatelyRender: false, // Next renders client components on the server too — avoid hydration mismatch
    extensions: [
      StarterKit.configure({ bold: false }), // bold replaced below so "__" is free for underline
      DiscordBold,
      DiscordUnderline,
      Spoiler,
      // html:true so <u>/spoiler-span round-trip. TipTap drops any unknown HTML; the display sanitizes too.
      Markdown.configure({ html: true, transformPastedText: true, breaks: true }),
    ],
    content: value, // parsed as markdown because the Markdown extension is registered
    autofocus: "end",
    editorProps: {
      attributes: { class: "gb-md gb-wysiwyg nodrag outline-none" },
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape") {
          onDone();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => onChange(editor.storage.markdown.getMarkdown()),
    onBlur: () => onDone(),
  });

  return <EditorContent editor={editor} />;
}
