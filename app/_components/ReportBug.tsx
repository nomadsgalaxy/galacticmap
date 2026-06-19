"use client";

import { useRef, useState } from "react";

// "Report a bug" → a small dialog. Always attaches the page + browser to the GitHub issue text. When you're
// on a board, it also offers an OPTIONAL one-click export of that board to attach — with a clear warning,
// since the issue (and the file you'd drop into it) is public. Nothing leaves the page unless you act.
export function ReportBug() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [exported, setExported] = useState(false);

  const open = () => {
    const m = window.location.pathname.match(/^\/boards\/([^/]+)/);
    setBoardId(m ? m[1] : null);
    setExported(false);
    dialog.current?.showModal();
  };

  const openIssue = () => {
    const body =
      "**What happened?**\n\n\n" +
      "**Steps to reproduce**\n\n\n" +
      "**Expected**\n\n\n" +
      (boardId && exported
        ? "**Debug export:** attached (drag the downloaded .galacticboard.json into this issue).\n\n"
        : "") +
      "---\n" +
      `- Page: ${window.location.href}\n` +
      `- Browser: ${navigator.userAgent}`;
    const url =
      "https://github.com/nomadsgalaxy/galacticmap/issues/new?labels=bug&title=" +
      encodeURIComponent("Bug: ") +
      "&body=" +
      encodeURIComponent(body);
    window.open(url, "_blank", "noopener,noreferrer");
    dialog.current?.close();
  };

  return (
    <>
      <button type="button" onClick={open} className="font-medium text-on-surface hover:underline">
        Report a bug
      </button>

      <dialog
        ref={dialog}
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
        className="m-auto w-[min(28rem,92vw)] rounded-panel border border-outline-variant bg-surface-container p-0 text-sm leading-normal text-on-surface shadow-elev-3 backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4 p-5 text-left">
          <div>
            <h2 className="text-base font-semibold text-on-surface">Report a bug</h2>
            <p className="mt-1 text-on-surface-variant">
              Your report includes this page&apos;s address and your browser. Add the steps and details on
              GitHub.
            </p>
          </div>

          {boardId && (
            <div className="rounded-control border border-outline-variant bg-surface p-3">
              <p className="font-medium text-on-surface">Attach debug info (optional)</p>
              <p className="mt-1 text-xs text-on-surface-variant">
                Downloads this board&apos;s full data. It contains your content and images, and the GitHub
                issue is public, so only attach it if you&apos;re okay sharing that. After it downloads, drag
                the file into the issue.
              </p>
              <a
                href={`/api/boards/${boardId}/export`}
                download
                onClick={() => setExported(true)}
                className="mt-2 inline-block rounded-control border border-outline-variant px-3 py-1.5 text-xs font-medium text-on-surface transition hover:bg-surface-variant active:scale-[.98]"
              >
                Download board data{exported ? " ✓" : ""}
              </a>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="rounded-control px-3 py-1.5 text-on-surface-variant transition hover:bg-surface-variant active:scale-[.98]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={openIssue}
              className="rounded-control bg-primary px-4 py-1.5 font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98]"
            >
              Open bug report
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
