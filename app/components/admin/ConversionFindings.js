import { createElement as h, useState } from "react";

const SEVERITY = { blocking: "Nutno vyřešit", warning: "Upozornění", info: "Informace" };

export function ConversionFindings({ findings = [], onSelectBlock, onDecision }) {
  const [reasons, setReasons] = useState({});
  if (!findings.length) return h("p", { className: "conversionOk" }, "Převod nemá žádné otevřené nálezy.");
  return h(
    "section",
    { className: "conversionFindings", "aria-labelledby": "conversion-findings-title" },
    h("h4", { id: "conversion-findings-title" }, "Nálezy převodu"),
    findings.map((finding) => h(
      "article",
      {
        key: finding.id,
        className: `conversionFinding ${finding.severity}`,
        role: finding.severity === "blocking" && finding.status === "open" ? "alert" : undefined,
      },
      h("div", null,
        h("b", null, SEVERITY[finding.severity] || "Nález"),
        h("span", null, finding.message),
        finding.status !== "open" && h("small", null, finding.status === "resolved" ? "Vyřešeno" : "Přijato"),
      ),
      finding.blockUid && h("button", { type: "button", onClick: () => onSelectBlock?.(finding.blockUid) }, "Zobrazit blok"),
      finding.status === "open" && onDecision && h("form", {
        onSubmit: (event) => {
          event.preventDefault();
          const reason = String(reasons[finding.id] || "").trim();
          if (reason) onDecision(finding, "resolved", reason);
        },
      },
      h("label", null, "Odůvodnění rozhodnutí",
        h("input", {
          value: reasons[finding.id] || "",
          required: true,
          onChange: (event) => setReasons((current) => ({ ...current, [finding.id]: event.target.value })),
        }),
      ),
      h("button", { type: "submit" }, "Označit jako vyřešené")),
    )),
  );
}
