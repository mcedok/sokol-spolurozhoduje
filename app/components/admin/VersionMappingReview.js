import { createElement as h, useEffect, useMemo, useState } from "react";

const RELATION_LABELS = {
  unchanged: "Beze změny",
  modified: "Upravený blok",
  moved: "Přesunutý blok",
  split: "Rozdělený blok",
  merged: "Sloučený blok",
  removed: "Odstraněný blok",
  added: "Nový blok",
};

export function VersionMappingReview({ versionId, api, canManage = false }) {
  const [run, setRun] = useState(null);
  const [reasons, setReasons] = useState({});
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function refresh() {
    const next = await api.getVersionMappings(versionId);
    setRun(next);
    return next;
  }

  useEffect(() => {
    if (!canManage || !versionId) return undefined;
    let active = true;
    api.getVersionMappings(versionId)
      .then((next) => { if (active) setRun(next); })
      .catch((caught) => { if (active) setError(caught.message || "Mapování se nepodařilo načíst."); });
    return () => { active = false; };
  }, [api, canManage, versionId]);

  const pending = useMemo(
    () => (run?.mappings || []).filter((mapping) => mapping.reviewStatus === "needs_review"),
    [run],
  );

  if (!canManage) return null;

  async function decide(mapping, decision) {
    const reason = (reasons[mapping.id] || "").trim();
    if (!reason) return;
    setBusyId(mapping.id);
    setError("");
    try {
      const next = await api.decideVersionMapping(mapping.id, {
        decision,
        reason,
        rowVersion: mapping.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      });
      setRun(next);
    } catch (caught) {
      if (caught.status === 409) {
        await refresh();
        setError("Mapování mezitím změnil jiný správce. Načetli jsme aktuální stav.");
      } else {
        setError(caught.message || "Rozhodnutí se nepodařilo uložit.");
      }
    } finally {
      setBusyId(null);
    }
  }

  return h("section", {
    className: "versionMappingReview adminSection",
    "aria-labelledby": `mapping-title-${versionId}`,
  },
  h("div", { className: "adminSectionTitle" }, h("div", null,
    h("h3", { id: `mapping-title-${versionId}` }, "Kontrola mapování verzí"),
    h("p", null, "Ověřte pouze nejasné vazby. Původní připomínky zůstávají beze změny."),
  )),
  error && h("p", { role: "alert", className: "formError" }, error),
  !run && !error && h("p", { role: "status", "aria-live": "polite" }, "Načítám mapování…"),
  run && pending.length === 0 && h("p", { className: "successNotice", "aria-live": "polite" }, "Všechna mapování jsou potvrzena."),
  pending.length > 0 && h("div", { className: "mappingList" }, pending.map((mapping, index) => {
    const reasonId = `mapping-reason-${mapping.id}`;
    return h("article", {
      key: mapping.id,
      className: "mappingItem",
      "aria-label": `Nejasná vazba ${index + 1}`,
    },
    h("div", { className: "mappingItemMeta" },
      h("strong", null, RELATION_LABELS[mapping.relation] || mapping.relation),
      h("span", { role: "status", className: "mappingConfidence" }, `${Math.round(mapping.confidence * 100)} % jistota`),
    ),
    h("div", { className: "mappingComparison" },
      h("section", { "aria-label": "Původní verze" }, h("h4", null, "Původní verze"), h("p", null, mapping.sourceText || "Bez zdrojového bloku")),
      h("section", { "aria-label": "Nová verze" }, h("h4", null, "Nová verze"), h("p", null, mapping.targetText || "Bez cílového bloku")),
    ),
    h("label", { htmlFor: reasonId }, "Odůvodnění rozhodnutí"),
    h("textarea", {
      id: reasonId,
      required: true,
      value: reasons[mapping.id] || "",
      onChange: (event) => setReasons((current) => ({ ...current, [mapping.id]: event.target.value })),
    }),
    h("div", { className: "mappingActions" },
      h("button", {
        type: "button",
        className: "primaryButton mappingDecisionButton",
        disabled: busyId === mapping.id || !(reasons[mapping.id] || "").trim(),
        onClick: () => decide(mapping, "confirm"),
      }, "Potvrdit vazbu"),
      h("button", {
        type: "button",
        className: "mappingDecisionButton",
        disabled: busyId === mapping.id || !(reasons[mapping.id] || "").trim(),
        onClick: () => decide(mapping, "reject"),
      }, "Odmítnout vazbu"),
    ));
  })),
  );
}
