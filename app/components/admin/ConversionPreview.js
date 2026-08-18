import { createElement as h, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

function safeHref(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? value : null;
  } catch { return null; }
}

function InlineRuns({ block }) {
  const runs = Array.isArray(block.structuredContent?.runs)
    ? block.structuredContent.runs
    : [{ text: block.text }];
  return runs.map((run, index) => {
    let content = String(run.text || "");
    if (run.bold) content = h("strong", null, content);
    if (run.italic) content = h("em", null, content);
    if (run.underline) content = h("u", null, content);
    if (run.highlight) content = h("mark", null, content);
    const href = safeHref(run.href);
    if (href) content = h("a", { href }, content);
    return h("span", { key: `${index}-${run.text}` }, content);
  });
}

function BlockBody({ block }) {
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
          row.map((cell, cellIndex) => h("td", { key: cellIndex }, String(cell.text || ""))),
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

function BlockCard({ block, index, active, onEdit }) {
  const ref = useRef(null);
  useEffect(() => { if (active) ref.current?.focus(); }, [active]);
  return h("article", {
    ref,
    id: `conversion-block-${block.blockUid}`,
    className: `conversionBlock${active ? " active" : ""}`,
    "aria-label": `Blok ${index + 1}`,
    tabIndex: active ? -1 : undefined,
  }, h("small", null, `Blok ${index + 1} · ${block.type}`), h(BlockBody, { block }), h("button", { type: "button", onClick: () => onEdit(block) }, "Upravit strukturu"));
}

export function ConversionPreview({ preview, activeBlockUid, onEditBlock, referenceUrl }) {
  const [tab, setTab] = useState("web");
  const [mobile, setMobile] = useState(false);
  const parentRef = useRef(null);
  const blocks = preview.blocks || [];
  const virtual = useVirtualizer({ count: blocks.length, getScrollElement: () => parentRef.current, estimateSize: () => 160, overscan: 5, enabled: blocks.length > 300 });
  const virtualItems = blocks.length > 300 ? virtual.getVirtualItems() : blocks.map((_, index) => ({ index, key: blocks[index].blockUid }));
  const activeIndex = blocks.findIndex((block) => block.blockUid === activeBlockUid);
  const items = activeIndex >= 0 && !virtualItems.some((item) => item.index === activeIndex)
    ? [...virtualItems, { index: activeIndex, key: blocks[activeIndex].blockUid, start: virtual.getOffsetForIndex(activeIndex)?.[0] || 0 }].sort((a, b) => a.index - b.index)
    : virtualItems;
  useEffect(() => {
    const query = globalThis.window?.matchMedia?.("(max-width: 760px)");
    if (!query) return undefined;
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  useEffect(() => {
    const index = blocks.findIndex((block) => block.blockUid === activeBlockUid);
    if (index >= 0 && blocks.length > 300) virtual.scrollToIndex(index, { align: "center" });
  }, [activeBlockUid, blocks.length]);

  return h("section", { className: "conversionPreview" },
    h("div", { className: "previewTabs", role: "tablist", "aria-label": "Porovnání dokumentu" },
      h("button", { type: "button", role: "tab", id: "tab-web", "aria-selected": tab === "web", "aria-controls": "panel-web", tabIndex: tab === "web" ? 0 : -1, onClick: () => setTab("web"), onKeyDown: (event) => { if (["ArrowRight", "ArrowLeft"].includes(event.key)) { event.preventDefault(); setTab("reference"); event.currentTarget.nextElementSibling?.focus(); } } }, "Webový dokument"),
      h("button", { type: "button", role: "tab", id: "tab-reference", "aria-selected": tab === "reference", "aria-controls": "panel-reference", tabIndex: tab === "reference" ? 0 : -1, onClick: () => setTab("reference"), onKeyDown: (event) => { if (["ArrowRight", "ArrowLeft"].includes(event.key)) { event.preventDefault(); setTab("web"); event.currentTarget.previousElementSibling?.focus(); } } }, "Referenční náhled"),
    ),
    h("div", { className: "previewPanels" },
      h("div", { ref: parentRef, id: "panel-web", role: "tabpanel", "aria-labelledby": "tab-web", hidden: mobile && tab !== "web", className: "webPreview" },
        h("div", { style: blocks.length > 300 ? { height: `${virtual.getTotalSize()}px`, position: "relative" } : undefined },
          items.map((item) => {
            const block = blocks[item.index];
            return h("div", { key: item.key, ref: blocks.length > 300 ? virtual.measureElement : undefined, "data-index": item.index, style: blocks.length > 300 ? { position: "absolute", width: "100%", transform: `translateY(${item.start}px)` } : undefined },
              h(BlockCard, { block, index: item.index, active: block.blockUid === activeBlockUid, onEdit: onEditBlock }),
            );
          }),
        ),
      ),
      h("div", { id: "panel-reference", role: "tabpanel", "aria-labelledby": "tab-reference", hidden: mobile && tab !== "reference", className: "referencePreview" },
        referenceUrl ? h("iframe", { title: "Referenční náhled dokumentu", src: referenceUrl }) : h("p", null, "Referenční náhled se připravuje nebo není dostupný."),
      ),
    ),
  );
}
