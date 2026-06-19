"use client";

// Opens a prefilled GitHub bug report in a new tab, with the current page + browser auto-attached so
// reports are actionable. No data leaves the page until the user submits the issue on GitHub.
export function ReportBug() {
  const report = () => {
    const body =
      "**What happened?**\n\n\n" +
      "**Steps to reproduce**\n\n\n" +
      "**Expected**\n\n\n" +
      "---\n" +
      `- Page: ${window.location.href}\n` +
      `- Browser: ${navigator.userAgent}`;
    const url =
      "https://github.com/nomadsgalaxy/galacticmap/issues/new?labels=bug&title=" +
      encodeURIComponent("Bug: ") +
      "&body=" +
      encodeURIComponent(body);
    window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <button type="button" onClick={report} className="font-medium text-on-surface hover:underline">
      Report a bug
    </button>
  );
}
