import { toPng, toSvg } from "html-to-image";
import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react";
import { jsPDF } from "jspdf";

function slug(title: string) {
  return (title || "board").replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60);
}
function download(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}
function capture(nodes: Node[]) {
  const bounds = getNodesBounds(nodes);
  const width = Math.max(640, Math.min(4096, Math.ceil(bounds.width + 160)));
  const height = Math.max(480, Math.min(4096, Math.ceil(bounds.height + 160)));
  const vp = getViewportForBounds(bounds, width, height, 0.2, 2, 0.12);
  const el = document.querySelector(".react-flow__viewport") as HTMLElement | null;
  const bg =
    getComputedStyle(document.documentElement).getPropertyValue("--md-sys-color-surface").trim() || "#ffffff";
  const style = {
    width: `${width}px`,
    height: `${height}px`,
    transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
  };
  return { el, width, height, style, bg };
}

export async function exportPng(nodes: Node[], title: string) {
  if (nodes.length === 0) return;
  const { el, width, height, style, bg } = capture(nodes);
  if (!el) return;
  const dataUrl = await toPng(el, { width, height, backgroundColor: bg, style, pixelRatio: 2 });
  download(dataUrl, `${slug(title)}.png`);
}

export async function exportSvg(nodes: Node[], title: string) {
  if (nodes.length === 0) return;
  const { el, width, height, style } = capture(nodes);
  if (!el) return;
  const dataUrl = await toSvg(el, { width, height, style });
  download(dataUrl, `${slug(title)}.svg`);
}

export async function exportPdf(nodes: Node[], title: string) {
  if (nodes.length === 0) return;
  const { el, width, height, style, bg } = capture(nodes);
  if (!el) return;
  const dataUrl = await toPng(el, { width, height, backgroundColor: bg, style, pixelRatio: 2 });
  const pdf = new jsPDF({ orientation: width > height ? "landscape" : "portrait", unit: "px", format: [width, height] });
  pdf.addImage(dataUrl, "PNG", 0, 0, width, height);
  pdf.save(`${slug(title)}.pdf`);
}
