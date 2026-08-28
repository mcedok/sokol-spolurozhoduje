import { createElement as h, useCallback, useEffect, useMemo, useState } from "react";
import { BlockStructureEditor } from "./BlockStructureEditor.js";
import { ConversionFindings } from "./ConversionFindings.js";
import { ConversionPreview } from "./ConversionPreview.js";
import { ConversionProgress } from "./ConversionProgress.js";
import { VersionMappingReview } from "./VersionMappingReview.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function DocumentConversionWizard({ document, api, onReady }) {
  const [versionId, setVersionId] = useState(null);
  const [processing, setProcessing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [editingBlock, setEditingBlock] = useState(null);
  const [activeBlockUid, setActiveBlockUid] = useState(null);
  const [referenceUrl, setReferenceUrl] = useState(null);
  const [error, setError] = useState("");
  const [mappingAvailable, setMappingAvailable] = useState(false);
  const [completionState, setCompletionState] = useState("idle");
  const [completionError, setCompletionError] = useState("");

  const refreshPreview = useCallback(async () => {
    if (!versionId) return null;
    const next = await api.getConversionPreview(versionId);
    setPreview(next);
    if (next.referenceFileId && api.createFileDownloadLink) {
      try {
        const link = await api.createFileDownloadLink(next.referenceFileId);
        setReferenceUrl(link?.url || link?.downloadUrl || null);
      } catch {
        setReferenceUrl(null);
      }
    }
    return next;
  }, [api, versionId]);

  const refreshProcessing = useCallback(async () => {
    if (!versionId) return null;
    const next = await api.getConversionProcessing(versionId);
    setProcessing(next);
    if (next.jobStatus === "completed" || next.versionStatus === "conversion_review") await refreshPreview();
    return next;
  }, [api, refreshPreview, versionId]);

  useEffect(() => {
    if (!versionId) return undefined;
    let timer;
    let cancelled = false;
    const poll = async () => {
      if (globalThis.document?.hidden) return;
      try {
        const next = await refreshProcessing();
        if (!cancelled && next && !["completed", "failed", "rejected"].includes(next.jobStatus)) {
          timer = setTimeout(poll, 2000);
        }
      } catch (caught) {
        setError(caught.message || "Stav převodu se nepodařilo načíst.");
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    const visible = () => { if (!globalThis.document.hidden) { clearTimeout(timer); void poll(); } };
    globalThis.document?.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearTimeout(timer); globalThis.document?.removeEventListener("visibilitychange", visible); };
  }, [refreshProcessing, versionId]);

  async function upload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".docx") || (file.type && file.type !== DOCX_MIME)) {
      setError("Vyberte dokument ve formátu DOCX.");
      event.target.value = "";
      return;
    }
    setError(""); setPreview(null); setEditingBlock(null);
    setCompletionState("idle"); setCompletionError("");
    setProcessing({ jobStatus: "scanning", versionStatus: "file_check", step: "file_check", attemptCount: 1 });
    try {
      const accepted = await api.uploadDocumentVersion(document.id, file, { rowVersion: document.rowVersion, idempotencyKey: crypto.randomUUID() });
      setVersionId(accepted.versionId);
    } catch (caught) { setProcessing(null); setError(caught.message || "Dokument se nepodařilo nahrát."); }
  }

  async function retry() {
    const retried = await api.retryConversion(processing.jobId, { rowVersion: processing.rowVersion, idempotencyKey: crypto.randomUUID() });
    setProcessing({ ...processing, ...retried, jobStatus: "queued" });
    await refreshProcessing();
  }

  async function decide(finding, status, reason) {
    await api.decideConversionFinding(finding.id, { status, reason, rowVersion: preview.rowVersion, idempotencyKey: crypto.randomUUID() });
    await refreshPreview();
  }

  const blockers = useMemo(() => (preview?.findings || []).filter((finding) => finding.severity === "blocking" && finding.status === "open"), [preview]);
  const unconfirmedTables = useMemo(() => (preview?.blocks || []).filter(
    (block) => block.type === "table" && !block.tableRepresentation,
  ), [preview]);
  async function complete() {
    setCompletionError("");
    if (unconfirmedTables.length > 0) {
      reviewTable(unconfirmedTables[0]);
      setCompletionError("Nejprve potvrďte způsob zobrazení zvýrazněné tabulky. Potom náhled potvrďte znovu.");
      return;
    }
    setCompletionState("pending");
    try {
      const result = await api.completeConversionReview(preview.id, { rowVersion: preview.rowVersion, idempotencyKey: crypto.randomUUID() });
      setProcessing((current) => ({ ...current, versionStatus: result.status }));
      const mappings = await api.generateVersionMappings(preview.id, {
        idempotencyKey: crypto.randomUUID(),
      });
      setMappingAvailable(Boolean(mappings));
      setCompletionState("success");
      await onReady?.();
    } catch (caught) {
      setCompletionState("idle");
      setCompletionError(caught.message || "Kontrolu se nepodařilo dokončit.");
    }
  }

  function reviewTable(block) {
    setEditingBlock(block);
    setActiveBlockUid(block.blockUid);
  }

  return h("section", { className: "documentConversionWizard", "aria-labelledby": `conversion-title-${document.id}` },
    h("div", { className: "adminSectionTitle" }, h("div", null, h("h3", { id: `conversion-title-${document.id}` }, "Dokument DOCX a kontrola převodu"), h("p", null, "Originál bezpečně uložíme a připravíme komentovatelnou webovou podobu."))),
    h("label", { className: "fileField wide" }, h("span", null, "Nahrát dokument DOCX"), h("input", { type: "file", accept: `.${"docx"},${DOCX_MIME}`, onChange: upload })),
    error && h("p", { role: "alert", className: "formError" }, error),
    h(ConversionProgress, { processing }),
    processing?.jobStatus === "failed" && h("button", { type: "button", onClick: retry }, "Zkusit převod znovu"),
    processing?.jobStatus === "rejected" && h("p", { role: "alert" }, "Tento soubor nelze opakovat. Nahrajte opravený DOCX."),
    preview && h("div", { className: "conversionReview" },
      h(ConversionPreview, { preview, activeBlockUid, onEditBlock: (block) => { setEditingBlock(block); setActiveBlockUid(block.blockUid); }, referenceUrl }),
      h(ConversionFindings, { findings: preview.findings, onSelectBlock: setActiveBlockUid, onDecision: decide }),
      editingBlock && h(BlockStructureEditor, {
        block: editingBlock,
        version: preview,
        api,
        onSaved: async () => { await refreshPreview(); setEditingBlock(null); },
        onConflict: refreshPreview,
        onClose: () => setEditingBlock(null),
      }),
      h("section", { className: "conversionSummary", "aria-labelledby": `conversion-summary-${preview.id}` },
        h("h4", { id: `conversion-summary-${preview.id}` }, "Souhrn kontroly"),
        h("p", null, `${preview.blocks.length} bloků · ${preview.blocks.filter((block) => block.type === "table").length} tabulek · ${(preview.findings || []).length} nálezů`),
        blockers.length > 0 && h("p", null, `Zbývá vyřešit ${blockers.length} blokujících nálezů.`),
        unconfirmedTables.length > 0 && h("p", null,
          unconfirmedTables.length === 1
            ? "1 tabulka čeká na potvrzení způsobu zobrazení."
            : `${unconfirmedTables.length} tabulky čekají na potvrzení způsobu zobrazení.`,
        ),
        unconfirmedTables.length > 0 && h("button", {
          type: "button",
          onClick: () => reviewTable(unconfirmedTables[0]),
        }, "Zkontrolovat tabulku"),
        completionError && h("p", { role: "alert", className: "formError" }, completionError),
        completionState === "success" && h("p", {
          role: "status",
          "aria-label": "Výsledek potvrzení náhledu",
          className: "conversionOk",
        }, "Náhled byl potvrzen. Dokument je připraven k navazujícímu kroku."),
        h("button", {
          type: "button",
          className: "primaryButton",
          disabled: blockers.length > 0 || completionState === "pending" || completionState === "success",
          onClick: complete,
        }, completionState === "pending" ? "Potvrzuji…" : "Potvrdit náhled"),
      ),
    ),
    mappingAvailable && h(VersionMappingReview, {
      versionId: preview.id,
      api,
      canManage: true,
    }),
  );
}
