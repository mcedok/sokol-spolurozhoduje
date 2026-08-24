import { createElement as h, useEffect, useState } from "react";

const BLOCK_TYPES = [
  "heading", "paragraph", "list_item", "table", "table_image",
  "attachment_reference", "quote", "callout", "technical_separator",
];
const TYPE_LABELS = {
  heading: "Nadpis", paragraph: "Odstavec", list_item: "Položka seznamu",
  table: "Tabulka", table_image: "Obrazová tabulka", attachment_reference: "Odkaz na přílohu",
  quote: "Citace", callout: "Zvýrazněné sdělení", technical_separator: "Technický oddělovač",
};

export function BlockStructureEditor({ block, version, api, onSaved, onConflict, onClose }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(block ? {
      type: block.type,
      commentable: block.commentable,
      tableRepresentation: block.tableRepresentation || "html",
      alternativeText: block.alternativeText || "",
      order: block.order,
      paragraphStart: block.sourceRange?.paragraphStart ?? "",
      paragraphEnd: block.sourceRange?.paragraphEnd ?? "",
      reason: "",
    } : null);
    setError("");
  }, [block?.blockUid]);
  if (!block || !draft) return null;

  async function submit(event) {
    event.preventDefault();
    const reason = draft.reason.trim();
    if (!reason) return;
    setError("");
    try {
      await api.updateBlockStructure(version.id, block.blockUid, {
        ...draft,
        reason,
        text: block.text,
        order: Number(draft.order),
        sourceRange: draft.paragraphStart === "" || draft.paragraphEnd === "" ? block.sourceRange : {
          ...block.sourceRange,
          paragraphStart: Number(draft.paragraphStart),
          paragraphEnd: Number(draft.paragraphEnd),
        },
        rowVersion: version.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      });
      await onSaved?.();
    } catch (caught) {
      if (caught?.status === 409) await onConflict?.();
      setError(caught?.status === 409
        ? "Náhled mezitím změnil jiný správce. Vaše volby zůstaly zachovány; načtěte aktuální náhled a porovnejte je."
        : caught?.message || "Strukturu se nepodařilo uložit.");
    }
  }

  return h("aside", { className: "blockStructureEditor", "aria-labelledby": "block-editor-title" },
    h("div", { className: "adminSectionTitle" }, h("h4", { id: "block-editor-title" }, "Upravit strukturu bloku"), h("button", { type: "button", onClick: onClose, "aria-label": "Zavřít editor" }, "×")),
    error && h("p", { role: "alert" }, error),
    h("form", { onSubmit: submit },
      h("label", null, "Text bloku", h("textarea", { value: block.text, readOnly: true })),
      h("label", null, "Typ bloku", h("select", { value: draft.type, onChange: (event) => setDraft({ ...draft, type: event.target.value }) },
        BLOCK_TYPES.map((type) => h("option", { key: type, value: type }, TYPE_LABELS[type])),
      )),
      h("label", null, "Pořadí bloku", h("input", { type: "number", min: 0, value: draft.order, onChange: (event) => setDraft({ ...draft, order: event.target.value }) })),
      block.sourceRange && h("fieldset", null,
        h("legend", null, "Hranice bloku v originálu"),
        h("label", null, "První odstavec", h("input", { type: "number", min: 0, value: draft.paragraphStart, onChange: (event) => setDraft({ ...draft, paragraphStart: event.target.value }) })),
        h("label", null, "Poslední odstavec", h("input", { type: "number", min: draft.paragraphStart || 0, value: draft.paragraphEnd, onChange: (event) => setDraft({ ...draft, paragraphEnd: event.target.value }) })),
      ),
      h("label", { className: "checkControl" }, h("input", { type: "checkbox", checked: draft.commentable, onChange: (event) => setDraft({ ...draft, commentable: event.target.checked }) }), "Blok lze připomínkovat"),
      draft.type === "table" && h("label", null, "Zobrazení tabulky", h("select", { value: draft.tableRepresentation, onChange: (event) => setDraft({ ...draft, tableRepresentation: event.target.value }) },
        h("option", { value: "html" }, "Webová tabulka"),
        h("option", { value: "image_with_attachment" }, "Obrázek a příloha"),
        h("option", { value: "attachment_only" }, "Pouze příloha"),
      )),
      draft.type === "table" && draft.tableRepresentation !== "html" && h("label", null, "Alternativní popis", h("textarea", { value: draft.alternativeText, required: true, onChange: (event) => setDraft({ ...draft, alternativeText: event.target.value }) })),
      h("label", null, "Důvod strukturální opravy", h("textarea", { value: draft.reason, required: true, onChange: (event) => setDraft({ ...draft, reason: event.target.value }) })),
      h("p", { className: "fieldHint" }, "Text nelze v náhledu měnit. Textovou opravu proveďte v novém DOCX."),
      h("button", { className: "primaryButton", type: "submit" }, "Uložit strukturu"),
    ),
  );
}
