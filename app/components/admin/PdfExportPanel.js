import { createElement as h, useEffect, useState } from "react";

const EMPTY_FILTERS = { statuses: [], priorities: [], types: [] };
const EMPTY_OPTIONS = {
  includeAuthorEmail: false,
  includeMembershipId: false,
  includeInternalNote: false,
};

const STATUS_TEXT = {
  queued: "Export čeká na zpracování.",
  processing: "Export se vytváří.",
  completed: "Export je připraven.",
  failed: "Export se nepodařilo vytvořit.",
};

const FILTER_GROUPS = [
  ["statuses", "Stav připomínky", [
    ["open", "Otevřené"],
    ["under_review", "V posouzení"],
    ["settled", "Vypořádané"],
    ["withdrawn", "Stažené"],
    ["hidden", "Skryté"],
  ]],
  ["priorities", "Priorita", [
    ["low", "Nízká priorita"],
    ["normal", "Běžná priorita"],
    ["high", "Vysoká priorita"],
    ["critical", "Kritická priorita"],
  ]],
  ["types", "Typ připomínky", [
    ["comment", "Komentáře"],
    ["proposal", "Návrhy"],
    ["question", "Dotazy"],
  ]],
];

export function PdfExportPanel({ document, api, canManage }) {
  const [visibility, setVisibility] = useState("public");
  const [options, setOptions] = useState(EMPTY_OPTIONS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [job, setJob] = useState(null);
  const [download, setDownload] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!job?.id || !["queued", "processing"].includes(job.status)) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await api.getPdfExport(job.id);
        if (!cancelled) setJob(next);
      } catch (caught) {
        if (!cancelled) setError(caught.message || "Stav exportu se nepodařilo načíst.");
      }
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, job]);

  if (!canManage) return null;

  function changeOption(name, checked) {
    setOptions((current) => ({ ...current, [name]: checked }));
  }

  function changeFilter(group, value, checked) {
    setFilters((current) => ({
      ...current,
      [group]: checked
        ? [...current[group], value]
        : current[group].filter((item) => item !== value),
    }));
  }

  async function create(event) {
    event.preventDefault();
    if (!document.latestReadyVersionId) return;
    setBusy(true);
    setError("");
    setDownload(null);
    try {
      const next = await api.createPdfExport(document.id, {
        documentVersionId: document.latestReadyVersionId,
        visibility,
        filters,
        options: visibility === "internal" ? options : EMPTY_OPTIONS,
        idempotencyKey: crypto.randomUUID(),
      });
      setJob(next);
    } catch (caught) {
      setError(caught.code === "FRESH_AUTHENTICATION_REQUIRED"
        ? "Interní export vyžaduje nové přihlášení administrátora."
        : caught.message || "Export se nepodařilo založit.");
    } finally {
      setBusy(false);
    }
  }

  async function prepareDownload() {
    setBusy(true);
    setError("");
    try {
      setDownload(await api.getPdfExportDownloadLink(job.id));
    } catch (caught) {
      setError(caught.message || "Odkaz ke stažení se nepodařilo připravit.");
    } finally {
      setBusy(false);
    }
  }

  return h("section", {
    className: "adminSection pdfExportPanel",
    "aria-labelledby": `pdf-export-title-${document.id}`,
  },
  h("div", { className: "adminSectionTitle" }, h("div", null,
    h("h3", { id: `pdf-export-title-${document.id}` }, "Export připomínek do PDF"),
    h("p", null, "Veřejná varianta skrývá interní údaje. Interní variantu vytvářejte jen pro oprávněné osoby."),
  )),
  !document.latestReadyVersionId
    ? h("p", { role: "status" }, "Export bude dostupný po potvrzení webové verze dokumentu.")
    : h("form", { className: "pdfExportForm", onSubmit: create },
      h("fieldset", null,
        h("legend", null, "Varianta exportu"),
        h("label", null, h("input", {
          type: "radio", name: "visibility", value: "public",
          checked: visibility === "public", onChange: () => setVisibility("public"),
        }), " Veřejné PDF"),
        h("label", null, h("input", {
          type: "radio", name: "visibility", value: "internal",
          checked: visibility === "internal", onChange: () => setVisibility("internal"),
        }), " Interní PDF"),
      ),
      h("div", { className: "pdfExportFilters" },
        h("p", null, "Filtry jsou volitelné. Bez výběru se exportují všechny připomínky."),
        FILTER_GROUPS.map(([group, legend, values]) => h("fieldset", { key: group },
          h("legend", null, legend),
          values.map(([value, label]) => h("label", { key: value }, h("input", {
            type: "checkbox",
            checked: filters[group].includes(value),
            onChange: (event) => changeFilter(group, value, event.target.checked),
          }), ` ${label}`)),
        )),
      ),
      visibility === "internal" && h("fieldset", null,
        h("legend", null, "Volitelné interní údaje"),
        h("label", null, h("input", { type: "checkbox", checked: options.includeAuthorEmail,
          onChange: (event) => changeOption("includeAuthorEmail", event.target.checked) }), " E-mail autora"),
        h("label", null, h("input", { type: "checkbox", checked: options.includeMembershipId,
          onChange: (event) => changeOption("includeMembershipId", event.target.checked) }), " Členské ID"),
        h("label", null, h("input", { type: "checkbox", checked: options.includeInternalNote,
          onChange: (event) => changeOption("includeInternalNote", event.target.checked) }), " Interní poznámka"),
      ),
      h("button", { className: "primaryButton", disabled: busy }, busy ? "Pracuji…" : "Vytvořit PDF"),
    ),
  error && h("p", { className: "formError", role: "alert" }, error),
  job && h("div", { className: "pdfExportStatus" },
    h("p", { role: "status", "aria-live": "polite" }, STATUS_TEXT[job.status] || job.status),
    job.status === "failed" && job.errorCode && h("small", null, `Kód chyby: ${job.errorCode}`),
    job.status === "completed" && h("button", {
      type: "button", disabled: busy, onClick: prepareDownload,
    }, "Připravit stažení"),
    download && h("p", null,
      h("a", { className: "primaryButton", href: download.url }, "Stáhnout PDF"),
      h("small", null, ` Odkaz platí do ${new Date(download.expiresAt).toLocaleTimeString("cs-CZ")}.`),
    ),
  ));
}
