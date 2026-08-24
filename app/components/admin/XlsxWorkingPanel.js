import { createElement as h, useEffect, useState } from "react";

const IMPORT_LABEL = {
  uploaded: "nahráno", scanning: "antivirová kontrola", validating: "ověření sešitu",
  comparing: "porovnávání změn", awaiting_resolution: "čeká na rozhodnutí",
  applying_safe: "používání bezpečných změn", applying_conflicts: "používání rozhodnutí",
  completed: "dokončeno", failed: "selhalo", cancelled: "zrušeno",
};

function describe(value) { return JSON.stringify(value, null, 0); }

export function XlsxWorkingPanel({ document, api = {}, canManage = false }) {
  const [job, setJob] = useState(null);
  const [batch, setBatch] = useState(null);
  const [rows, setRows] = useState([]);
  const [invalidRows, setInvalidRows] = useState([]);
  const [decisions, setDecisions] = useState({});
  const [conflictOffset, setConflictOffset] = useState(0);
  const [invalidOffset, setInvalidOffset] = useState(0);
  const [conflictTotal, setConflictTotal] = useState(0);
  const [invalidTotal, setInvalidTotal] = useState(0);
  const [undecidedTotal, setUndecidedTotal] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!job?.id || !["queued", "processing"].includes(job.status) || !api.getXlsxExport) return undefined;
    let active = true;
    const refresh = async () => {
      try { const next = await api.getXlsxExport(job.id); if (active) setJob(next?.job || next); }
      catch (error) { if (active) setMessage(error?.message || "Stav exportu se nepodařilo načíst."); }
    };
    const timer = setInterval(refresh, 1500); refresh();
    return () => { active = false; clearInterval(timer); };
  }, [job?.id, job?.status, api]);

  useEffect(() => {
    if (!batch?.id) return undefined;
    let active = true;
    let timer;
    async function refresh() {
      try {
        const next = await api.getXlsxImport?.(batch.id);
        if (active && next) setBatch(next?.batch || next);
      } catch (error) { if (active) setMessage(error?.message || "Stav importu se nepodařilo načíst."); }
    }
    if (["uploaded", "scanning", "validating", "comparing", "applying_safe", "applying_conflicts"].includes(batch.status)) {
      timer = setInterval(refresh, 1500); refresh();
    }
    if (batch.status === "awaiting_resolution") {
      (async () => {
        try {
          const [conflicts, invalid] = await Promise.all([
            api.getXlsxImportRows?.(batch.id, "conflict", conflictOffset),
            api.getXlsxImportRows?.(batch.id, "invalid", invalidOffset),
          ]);
          if (active) {
            setRows(conflicts?.rows || []); setInvalidRows(invalid?.rows || []);
            setConflictTotal(conflicts?.total ?? conflicts?.rows?.length ?? 0);
            setInvalidTotal(invalid?.total ?? invalid?.rows?.length ?? 0);
            setUndecidedTotal(conflicts?.undecidedTotal ?? 0);
            setDecisions(Object.fromEntries((conflicts?.rows || [])
              .filter((row) => row.latestDecision)
              .map((row) => [row.id, row.latestDecision])));
          }
        } catch (error) { if (active) setMessage(error?.message || "Konfliktní řádky se nepodařilo načíst."); }
      })();
    }
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [batch?.id, batch?.status, batch?.rowVersion, api, conflictOffset, invalidOffset]);

  if (!canManage) return null;

  async function createExport() {
    setBusy(true); setMessage(""); setDownloadUrl(""); setBatch(null); setRows([]); setInvalidRows([]);
    try {
      const value = await api.createXlsxExport?.(document.id, document.latestReadyVersionId);
      setJob(value?.job || value || null); setMessage("Export byl zařazen ke zpracování.");
    } catch (error) { setMessage(error?.message || "Export se nepodařilo založit."); }
    finally { setBusy(false); }
  }

  async function prepareDownload() {
    setBusy(true); setMessage("");
    try { const link = await api.getXlsxExportDownloadLink?.(job.id); setDownloadUrl(link?.url || ""); }
    catch (error) { setMessage(error?.message || "Odkaz ke stažení se nepodařilo vytvořit."); }
    finally { setBusy(false); }
  }

  async function upload(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setMessage(""); setRows([]); setInvalidRows([]); setDecisions({});
    try {
      const value = await api.uploadXlsxImport?.(document.id, file, job?.id);
      setBatch(value?.batch || value || null); setMessage("Soubor byl přijat do bezpečné karantény.");
    } catch (error) { setMessage(error?.message || "Import se nepodařilo přijmout."); }
    finally { setBusy(false); event.target.value = ""; }
  }

  async function decide(row, decision) {
    setBusy(true); setMessage("");
    try {
      const result = await api.decideXlsxConflict?.(batch.id, row.id, decision, row.rowVersion,
        decision === "use_xlsx" ? "Administrátor potvrdil hodnoty z XLSX." : "Administrátor ponechal aktuální stav systému.");
      setDecisions((current) => ({ ...current, [row.id]: decision }));
      setRows((current) => current.map((item) => item.id === row.id
        ? { ...item, rowVersion: result?.rowVersion ?? item.rowVersion + 1, latestDecision: decision }
        : item));
      if (!row.latestDecision) setUndecidedTotal((current) => Math.max(0, current - 1));
    } catch (error) { setMessage(error?.message || "Rozhodnutí konfliktu se nepodařilo uložit."); }
    finally { setBusy(false); }
  }

  async function applyConflicts() {
    setBusy(true); setMessage("");
    try {
      const result = await api.applyXlsxConflicts?.(batch.id, batch.rowVersion);
      setBatch((current) => ({ ...current, status: result.status }));
      setMessage(`Rozhodnutí byla použita: ${result.applied} změn, ${result.skipped} ponecháno.`);
    } catch (error) { setMessage(error?.message || "Rozhodnutí konfliktů se nepodařilo použít."); }
    finally { setBusy(false); }
  }

  async function cancelImport() {
    setBusy(true); setMessage("");
    try {
      await api.cancelXlsxImport?.(batch.id, batch.rowVersion);
      setBatch((current) => ({ ...current, status: "cancelled" }));
      setRows([]); setMessage("Import byl zrušen.");
    } catch (error) { setMessage(error?.message || "Import se nepodařilo zrušit."); }
    finally { setBusy(false); }
  }

  async function retryImport() {
    setBusy(true); setMessage("");
    try {
      const result = await api.retryXlsxImport?.(batch.id, batch.rowVersion);
      setBatch(result?.batch || result || null);
      setRows([]); setInvalidRows([]); setDecisions({});
      setMessage("Import byl znovu zařazen ke kontrole.");
    } catch (error) { setMessage(error?.message || "Import se nepodařilo znovu zařadit."); }
    finally { setBusy(false); }
  }

  const allDecided = conflictTotal > 0 && undecidedTotal === 0;
  return h("section", { className: "adminSection xlsxWorkingPanel", "aria-labelledby": "xlsx-working-title" },
    h("div", { className: "adminSectionTitle" }, h("div", null,
      h("h3", { id: "xlsx-working-title" }, "Pracovní XLSX"),
      h("p", null, "Export připomínek pro administrátora a bezpečný zpětný import změn."),
    )),
    h("div", { className: "adminControls" },
      h("button", { type: "button", className: "primaryButton", disabled: busy || !document.latestReadyVersionId, onClick: createExport }, "Vytvořit XLSX"),
      job?.status === "completed" && h("button", { type: "button", className: "secondaryButton", disabled: busy, onClick: prepareDownload }, "Připravit odkaz ke stažení"),
      downloadUrl && h("a", { className: "secondaryButton", href: downloadUrl, target: "_blank", rel: "noreferrer" }, "Stáhnout pracovní XLSX"),
      h("label", { className: `secondaryButton${!job?.id ? " isDisabled" : ""}`, htmlFor: "xlsx-import-file" }, "Nahrát upravený XLSX"),
      h("input", { id: "xlsx-import-file", className: "srOnly", type: "file",
        accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        onChange: upload, disabled: busy || !job?.id }),
    ),
    h("p", { role: message.toLowerCase().includes("nepodařilo") ? "alert" : "status", "aria-live": "polite" }, message),
    job && h("p", null, `Export: ${job.status}`),
    batch && h("div", { className: "xlsxImportSummary" },
      h("strong", null, `Import: ${IMPORT_LABEL[batch.status] || batch.status}`),
      batch.counts && h("span", null, ` · bezpečné ${batch.counts.safeChange ?? 0}, konflikty ${batch.counts.conflict ?? 0}, chybné ${batch.counts.invalid ?? 0}`),
      batch.status === "awaiting_resolution" && h("button", {
        type: "button", className: "secondaryButton", disabled: busy, onClick: cancelImport,
      }, "Zrušit import"),
      batch.status === "failed" && h("button", {
        type: "button", className: "secondaryButton", disabled: busy, onClick: retryImport,
      }, "Zkusit import znovu"),
    ),
    rows.length > 0 && h("div", { className: "xlsxConflictList" },
      h("h4", null, "Konflikty k rozhodnutí"),
      ...rows.map((row) => h("div", { key: row.id, className: "xlsxConflictCard", role: "group", "aria-label": `Konflikt na řádku ${row.sourceRowNumber}` },
        h("p", null, `Základ: ${describe(row.base)}`), h("p", null, `Systém: ${describe(row.current)}`),
        h("p", null, `XLSX: ${describe(row.incoming)}`),
        h("div", { className: "adminControls" },
          h("button", { type: "button", disabled: busy, "aria-pressed": decisions[row.id] === "keep_system", onClick: () => decide(row, "keep_system") }, "Ponechat systém"),
          h("button", { type: "button", disabled: busy, "aria-pressed": decisions[row.id] === "use_xlsx", onClick: () => decide(row, "use_xlsx") }, "Použít XLSX"),
        ),
      )),
      h("div", { className: "adminControls", "aria-label": "Stránkování konfliktů" },
        h("button", { type: "button", disabled: busy || conflictOffset === 0,
          onClick: () => setConflictOffset((value) => Math.max(0, value - 100)) }, "Předchozí konflikty"),
        h("span", null, `${conflictOffset + 1}–${Math.min(conflictOffset + rows.length, conflictTotal)} z ${conflictTotal}`),
        h("button", { type: "button", disabled: busy || conflictOffset + rows.length >= conflictTotal,
          onClick: () => setConflictOffset((value) => value + 100) }, "Další konflikty"),
      ),
      h("button", { type: "button", className: "primaryButton", disabled: busy || !allDecided, onClick: applyConflicts }, "Použít rozhodnutí konfliktů"),
    ),
    invalidRows.length > 0 && h("div", { className: "xlsxConflictList" },
      h("h4", null, "Řádky vyžadující opravu sešitu"),
      ...invalidRows.map((row) => h("div", { key: row.id, className: "xlsxConflictCard" },
        h("strong", null, `Řádek ${row.sourceRowNumber}`),
        h("p", null, (row.validationErrors || []).join(", ") || "Neplatné hodnoty."),
      )),
      h("div", { className: "adminControls", "aria-label": "Stránkování chybných řádků" },
        h("button", { type: "button", disabled: busy || invalidOffset === 0,
          onClick: () => setInvalidOffset((value) => Math.max(0, value - 100)) }, "Předchozí chybné řádky"),
        h("span", null, `${invalidOffset + 1}–${Math.min(invalidOffset + invalidRows.length, invalidTotal)} z ${invalidTotal}`),
        h("button", { type: "button", disabled: busy || invalidOffset + invalidRows.length >= invalidTotal,
          onClick: () => setInvalidOffset((value) => value + 100) }, "Další chybné řádky"),
      ),
    ),
  );
}
