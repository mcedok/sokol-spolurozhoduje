import { createElement as h, useEffect, useState } from "react";
import { DocumentConversionWizard } from "./DocumentConversionWizard.js";
import { PdfExportPanel } from "./PdfExportPanel.js";

const STATUS_OPTIONS = [
  "Koncept",
  "K připomínkování",
  "Vypořádání",
  "Ke schválení",
  "Schváleno",
  "Neschváleno",
  "Archivováno",
];
const CLOSED_STATUSES = new Set(["Schváleno", "Neschváleno", "Archivováno"]);
const STATUS_CLASSES = {
  Koncept: "neutral",
  "K připomínkování": "open",
  Vypořádání: "review",
  "Ke schválení": "review",
  Schváleno: "approved",
  Neschváleno: "rejected",
  Archivováno: "neutral",
};

function StatusBadge({ value }) {
  return h("span", { className: `statusBadge ${STATUS_CLASSES[value] || "neutral"}` }, value);
}

function editableDraft(norm) {
  return {
    status: norm?.status || "Koncept",
    commentsOpen: Boolean(norm?.commentsOpen),
    closureReason: norm?.closureReason || "",
    deadline: norm?.deadline || "",
    submittedBy: norm?.submittedBy || "",
    responsible: norm?.responsible || "",
    reason: norm?.reason || "",
  };
}

export function NormAdministration({ norms = [], selectedNorm, currentUser, actions = {} }) {
  const title = currentUser?.role === "superadmin" ? "Všechny normy" : "Moje normy";
  const [draft, setDraft] = useState(() => editableDraft(selectedNorm));

  useEffect(() => {
    setDraft(editableDraft(selectedNorm));
  }, [selectedNorm?.id, selectedNorm?.status, selectedNorm?.commentsOpen]);

  function change(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function changeStatus(status) {
    setDraft((current) => ({
      ...current,
      status,
      commentsOpen: CLOSED_STATUSES.has(status) ? false : current.commentsOpen,
    }));
  }

  function toggleComments() {
    setDraft((current) => ({
      ...current,
      commentsOpen: !current.commentsOpen,
      closureReason: current.commentsOpen ? current.closureReason : "",
    }));
  }

  async function saveNorm(event) {
    event.preventDefault();
    const result = await actions.updateNorm?.(selectedNorm.id, draft);
    if (result?.norm) setDraft(editableDraft(result.norm));
  }

  async function resolveSubmission(event, submissionId) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await actions.resolveSubmission?.(selectedNorm.id, submissionId, {
      resolutionStatus: String(form.get("resolutionStatus") || ""),
      resolution: String(form.get("resolution") || "").trim(),
      adminComment: String(form.get("adminComment") || "").trim(),
    });
  }

  async function addReply(event, submissionId) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const text = String(new FormData(formElement).get("reply") || "").trim();
    if (!text) return;
    const result = await actions.addReply?.(selectedNorm.id, submissionId, text);
    if (result) formElement.reset();
  }

  const needsClosureReason =
    !draft.commentsOpen && Boolean(selectedNorm?.commentsOpen || draft.closureReason);

  return h(
    "section",
    { className: "adminPage" },
    h(
      "div",
      { className: "adminHeading" },
      h("div", null,
        h("p", { className: "kicker" }, "Rozhraní předkladatele"),
        h("h1", null, title),
        h("p", null, "Publikace materiálů, řízení připomínkování a transparentní vypořádání podnětů."),
      ),
      h("button", { className: "primaryButton", onClick: actions.openCreate }, "+ Předložit novou normu"),
    ),
    h(
      "p",
      { className: "demoBoundary", role: "note" },
      "Lokální demoverze: data zůstávají pouze v tomto profilu prohlížeče. Produkční správa norem vyžaduje serverové úložiště a autorizaci.",
    ),
    h(
      "div",
      { className: "adminLayout" },
      h(
        "nav",
        { className: "adminNormList", "aria-label": "Spravované normy" },
        norms.map((norm) => h(
          "button",
          {
            key: norm.id,
            className: norm.id === selectedNorm?.id ? "active" : "",
            "aria-current": norm.id === selectedNorm?.id ? "page" : undefined,
            onClick: () => actions.selectNorm?.(norm.id),
          },
          h("span", null, norm.number),
          h("b", null, norm.title),
          h(StatusBadge, { value: norm.status }),
        )),
      ),
      selectedNorm
        ? h(
          "div",
          { className: "adminWorkspace" },
          h(
            "div",
            { className: "adminToolbar" },
            h("div", null, h("span", { className: "normNumber" }, selectedNorm.number), h("h2", null, selectedNorm.title)),
            h("div", null,
              h("button", { onClick: () => actions.openPublic?.(selectedNorm.id) }, "Veřejný náhled"),
              h("button", { className: "dangerButton", onClick: () => actions.deleteNorm?.(selectedNorm) }, "Smazat"),
            ),
          ),
          h(
            "form",
            { className: "normEditForm", onSubmit: saveNorm },
            h(
              "section",
              { className: "adminSection" },
              h(
                "div",
                { className: "adminSectionTitle" },
                h("div", null,
                  h("h3", null, "Stav a připomínkování"),
                  h("p", null, "Změny se uloží až po potvrzení formuláře."),
                ),
                h(StatusBadge, { value: draft.status }),
              ),
              h(
                "div",
                { className: "adminControls" },
                h("label", null, "Status normy",
                  h("select", { value: draft.status, onChange: (event) => changeStatus(event.target.value) },
                    STATUS_OPTIONS.map((status) => h("option", { key: status, value: status }, status)),
                  ),
                ),
                h("label", null, "Termín připomínek",
                  h("input", { type: "date", value: draft.deadline, onChange: (event) => change("deadline", event.target.value) }),
                ),
                h("div", { className: "toggleControl" },
                  h("span", null, "Připomínky jsou ", h("b", null, draft.commentsOpen ? "otevřené" : "uzavřené")),
                  h("button", {
                    type: "button",
                    className: draft.commentsOpen ? "closeButton" : "primaryButton small",
                    "aria-pressed": draft.commentsOpen ? "false" : "true",
                    onClick: toggleComments,
                  }, draft.commentsOpen ? "Uzavřít připomínky" : "Otevřít připomínky"),
                ),
                needsClosureReason && h("label", { className: "wide" }, "Důvod uzavření připomínek",
                  h("textarea", {
                    value: draft.closureReason,
                    required: true,
                    onChange: (event) => change("closureReason", event.target.value),
                  }),
                ),
              ),
            ),
            h(
              "section",
              { className: "adminSection" },
              h("div", { className: "adminSectionTitle" },
                h("div", null, h("h3", null, "Dokument a odpovědnost"), h("p", null, "Údaje, které členové uvidí u normy.")),
              ),
              h(
                "div",
                { className: "adminControls twoColumns" },
                h("label", null, "Předkladatel",
                  h("input", { value: draft.submittedBy, onChange: (event) => change("submittedBy", event.target.value) }),
                ),
                h("label", null, "Odpovídá za normu",
                  h("input", { value: draft.responsible, onChange: (event) => change("responsible", event.target.value) }),
                ),
                h("label", { className: "wide" }, "Průvodní informace / důvodová zpráva",
                  h("textarea", { value: draft.reason, onChange: (event) => change("reason", event.target.value) }),
                ),
              ),
            ),
            h("div", { className: "normEditActions" },
              h("button", { className: "primaryButton", type: "submit" }, "Uložit změny normy"),
            ),
          ),
          actions.uploadDocumentVersion
            ? h(DocumentConversionWizard, {
              key: selectedNorm.id,
              document: selectedNorm,
              api: actions,
              onReady: actions.refresh,
            })
            : h("section", { className: "adminSection" },
              h("h3", null, "Dokument DOCX"),
            h("p", null, "Produkční převod dokumentu je dostupný po připojení k serveru."),
            ),
          h(PdfExportPanel, {
            document: selectedNorm,
            api: actions,
            canManage: currentUser?.role === "admin" || currentUser?.role === "superadmin",
          }),
          h(
            "section",
            { className: "adminSection" },
            h("div", { className: "adminSectionTitle" },
              h("div", null,
                h("h3", null, "Vypořádání podnětů"),
                h("p", null, `${selectedNorm.submissions.filter((item) => item.resolutionStatus === "Nevypořádáno").length} čeká na rozhodnutí.`),
              ),
            ),
            h(
              "div",
              { className: "resolutionList" },
              selectedNorm.submissions.length
                ? selectedNorm.submissions.map((item) => h(
                  "article",
                  { className: "resolutionItem", key: item.id },
                  h("div", null,
                    h("span", null, `${item.kind} · ${item.section}`),
                    h("h4", null, item.title),
                    h("p", null, item.text),
                    h("small", null, `${item.author}, ${item.unit} · podpora ${item.score}`),
                  ),
                  h("form", { onSubmit: (event) => resolveSubmission(event, item.id) },
                    h("label", null, "Výsledek",
                      h("select", { name: "resolutionStatus", defaultValue: item.resolutionStatus },
                        h("option", { value: "Nevypořádáno" }, "Nevypořádáno"),
                        h("option", { value: "Zapracováno" }, "Zapracováno"),
                        h("option", { value: "Nezapracováno" }, "Nezapracováno"),
                      ),
                    ),
                    h("label", null, "Odůvodnění rozhodnutí",
                      h("textarea", { name: "resolution", defaultValue: item.resolution, placeholder: "Popište, jak a proč byl podnět vypořádán.", required: true }),
                    ),
                    h("label", null, "Komentář předkladatele",
                      h("input", { name: "adminComment", defaultValue: item.adminComment, placeholder: "Volitelná doplňující odpověď" }),
                    ),
                    h("button", { className: "primaryButton small" }, "Uložit vypořádání"),
                  ),
                  h("form", { className: "adminReply", onSubmit: (event) => addReply(event, item.id) },
                    h("input", { name: "reply", placeholder: "Okomentovat podnět jako předkladatel…", required: true }),
                    h("button", null, "Odeslat komentář"),
                  ),
                ))
                : h("div", { className: "emptyState" }, "U této normy zatím nejsou žádné podněty."),
            ),
          ),
        )
        : h("div", { className: "emptyState" }, "Nejprve založte novou normu."),
    ),
  );
}
