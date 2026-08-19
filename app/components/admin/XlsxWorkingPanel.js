import { createElement as h, useState } from "react";

export function XlsxWorkingPanel({ document, api = {}, canManage = false }) {
  const [job, setJob] = useState(null);
  const [batch, setBatch] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!canManage) return null;
  async function createExport() {
    setBusy(true); setMessage("");
    try { const value = await api.createXlsxExport?.(document.id, document.latestReadyVersionId); setJob(value?.job || value || null); setMessage("Export připraven ke zpracování."); }
    catch (error) { setMessage(error?.message || "Export se nepodařilo založit."); }
    finally { setBusy(false); }
  }
  async function upload(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setMessage("");
    try { const value = await api.uploadXlsxImport?.(document.id, file, job?.id); setBatch(value?.batch || value || null); setMessage("Soubor byl přijat do bezpečné karantény."); }
    catch (error) { setMessage(error?.message || "Import se nepodařilo přijmout."); }
    finally { setBusy(false); event.target.value = ""; }
  }
  return h("section", { className: "adminSection xlsxWorkingPanel", "aria-labelledby": "xlsx-working-title" },
    h("div", { className: "adminSectionTitle" }, h("div", null,
      h("h3", { id: "xlsx-working-title" }, "Pracovní XLSX"),
      h("p", null, "Export připomínek pro administrátora a bezpečný zpětný import změn."),
    )),
    h("div", { className: "adminControls" },
      h("button", { type: "button", className: "primaryButton", disabled: busy, onClick: createExport }, "Vytvořit XLSX"),
      h("label", { className: "secondaryButton" }, "Nahrát upravený XLSX",
        h("input", { type: "file", accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", onChange: upload, hidden: true, disabled: busy })),
    ),
    h("p", { role: "status", "aria-live": "polite" }, message),
    job && h("p", null, `Export: ${job.status || "queued"}`),
    batch && h("div", { className: "xlsxImportSummary" },
      h("strong", null, `Import: ${batch.status}`),
      batch.counts && h("span", null, ` · bezpečné ${batch.counts.safeChange ?? 0}, konflikty ${batch.counts.conflict ?? 0}, chybné ${batch.counts.invalid ?? 0}`),
    ),
  );
}
