import { createElement as h } from "react";

function safeHref(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function InlineRuns({ block }) {
  const raw = Array.isArray(block.structuredContent?.runs)
    ? block.structuredContent.runs
    : Array.isArray(block.structuredContent?.content)
      ? block.structuredContent.content
      : [{ text: block.text }];
  return raw.map((run, index) => {
    let content = String(run.text || "");
    if (run.bold) content = h("strong", null, content);
    if (run.italic) content = h("em", null, content);
    if (run.underline) content = h("u", null, content);
    if (run.highlight) content = h("mark", null, content);
    const href = safeHref(run.href);
    if (href) content = h("a", { href, rel: "noreferrer" }, content);
    return h("span", { key: `${index}-${run.text}` }, content);
  });
}

export function StructuredBlockContent({ block }) {
  if (block.type === "heading") {
    const level = Math.min(6, Math.max(2, Number(block.structuredContent?.level || 2)));
    return h(`h${level}`, null, h(InlineRuns, { block }));
  }
  if (block.type === "technical_separator") return h("hr", { "aria-label": "Oddělovač" });
  if (block.type === "table") {
    const rows = Array.isArray(block.structuredContent?.rows) ? block.structuredContent.rows : [];
    return rows.length
      ? h("div", { className: "convertedTable" }, h("table", null, h("tbody", null,
        rows.map((row, rowIndex) => h("tr", { key: rowIndex },
          row.map((cell, cellIndex) => h("td", {
            key: cellIndex,
            rowSpan: Number(cell.rowSpan || 1),
            colSpan: Number(cell.colSpan || 1),
          }, String(cell.text || ""))),
        )),
      )))
      : h("p", null, block.text);
  }
  if (block.type === "table_image") return h("figure", null, h("figcaption", null, block.alternativeText || block.text));
  if (block.type === "list_item") {
    const list = block.structuredContent?.listKind === "ordered" ? "ol" : "ul";
    return h(list, null, h("li", null, h(InlineRuns, { block })));
  }
  if (block.type === "quote") return h("blockquote", null, h(InlineRuns, { block }));
  if (block.type === "callout") return h("aside", { className: "convertedCallout" }, h(InlineRuns, { block }));
  return h("p", null, h(InlineRuns, { block }));
}
