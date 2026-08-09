import { jsxs, jsx } from "react/jsx-runtime";
const STATUS_OPTIONS = [
  "Koncept",
  "K p\u0159ipom\xEDnkov\xE1n\xED",
  "Vypo\u0159\xE1d\xE1n\xED",
  "Ke schv\xE1len\xED",
  "Schv\xE1leno",
  "Neschv\xE1leno",
  "Archivov\xE1no"
];
const STATUS_CLASSES = {
  Koncept: "neutral",
  "K p\u0159ipom\xEDnkov\xE1n\xED": "open",
  Vypo\u0159\u00E1d\u00E1n\u00ED: "review",
  "Ke schv\xE1len\xED": "review",
  Schv\u00E1leno: "approved",
  Neschv\u00E1leno: "rejected",
  Archivov\u00E1no: "neutral"
};
function StatusBadge({ value }) {
  return /* @__PURE__ */ jsx("span", { className: `statusBadge ${STATUS_CLASSES[value] || "neutral"}`, children: value });
}
function NormAdministration({ norms = [], selectedNorm, currentUser, actions = {} }) {
  const title = currentUser?.role === "superadmin" ? "V\u0161echny normy" : "Moje normy";
  async function resolveSubmission(event, submissionId) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await actions.resolveSubmission?.(selectedNorm.id, submissionId, {
      resolutionStatus: String(form.get("resolutionStatus") || ""),
      resolution: String(form.get("resolution") || "").trim(),
      adminComment: String(form.get("adminComment") || "").trim()
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
  return /* @__PURE__ */ jsxs("section", { className: "adminPage", children: [
    /* @__PURE__ */ jsxs("div", { className: "adminHeading", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("p", { className: "kicker", children: "Rozhran\xED p\u0159edkladatele" }),
        /* @__PURE__ */ jsx("h1", { children: title }),
        /* @__PURE__ */ jsx("p", { children: "Publikace materi\xE1l\u016F, \u0159\xEDzen\xED p\u0159ipom\xEDnkov\xE1n\xED a transparentn\xED vypo\u0159\xE1d\xE1n\xED podn\u011Bt\u016F." })
      ] }),
      /* @__PURE__ */ jsx("button", { className: "primaryButton", onClick: actions.openCreate, children: "+ P\u0159edlo\u017Eit novou normu" })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "adminLayout", children: [
      /* @__PURE__ */ jsx("nav", { className: "adminNormList", "aria-label": "Spravovan\xE9 normy", children: norms.map((norm) => /* @__PURE__ */ jsxs("button", { className: norm.id === selectedNorm?.id ? "active" : "", onClick: () => actions.selectNorm?.(norm.id), children: [
        /* @__PURE__ */ jsx("span", { children: norm.number }),
        /* @__PURE__ */ jsx("b", { children: norm.title }),
        /* @__PURE__ */ jsx(StatusBadge, { value: norm.status })
      ] }, norm.id)) }),
      selectedNorm ? /* @__PURE__ */ jsxs("div", { className: "adminWorkspace", children: [
        /* @__PURE__ */ jsxs("div", { className: "adminToolbar", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("span", { className: "normNumber", children: selectedNorm.number }),
            /* @__PURE__ */ jsx("h2", { children: selectedNorm.title })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("button", { onClick: () => actions.openPublic?.(selectedNorm.id), children: "Ve\u0159ejn\xFD n\xE1hled" }),
            /* @__PURE__ */ jsx("button", { className: "dangerButton", onClick: () => actions.deleteNorm?.(selectedNorm), children: "Smazat" })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("section", { className: "adminSection", children: [
          /* @__PURE__ */ jsxs("div", { className: "adminSectionTitle", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("h3", { children: "Stav a p\u0159ipom\xEDnkov\xE1n\xED" }),
              /* @__PURE__ */ jsx("p", { children: "Zm\u011Bny se ihned projev\xED ve ve\u0159ejn\xE9m n\xE1hledu." })
            ] }),
            /* @__PURE__ */ jsx(StatusBadge, { value: selectedNorm.status })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "adminControls", children: [
            /* @__PURE__ */ jsxs("label", { children: [
              "Status normy",
              /* @__PURE__ */ jsx("select", { value: selectedNorm.status, onChange: (event) => actions.updateNorm?.(selectedNorm.id, { status: event.target.value }), children: STATUS_OPTIONS.map((status) => /* @__PURE__ */ jsx("option", { children: status }, status)) })
            ] }),
            /* @__PURE__ */ jsxs("label", { children: [
              "Term\xEDn p\u0159ipom\xEDnek",
              /* @__PURE__ */ jsx("input", { type: "date", value: selectedNorm.deadline || "", onChange: (event) => actions.updateNorm?.(selectedNorm.id, { deadline: event.target.value }) })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "toggleControl", children: [
              /* @__PURE__ */ jsxs("span", { children: [
                "P\u0159ipom\xEDnky jsou ",
                /* @__PURE__ */ jsx("b", { children: selectedNorm.commentsOpen ? "otev\u0159en\xE9" : "uzav\u0159en\xE9" })
              ] }),
              /* @__PURE__ */ jsx("button", { className: selectedNorm.commentsOpen ? "closeButton" : "primaryButton small", onClick: () => actions.updateNorm?.(selectedNorm.id, { commentsOpen: !selectedNorm.commentsOpen }), children: selectedNorm.commentsOpen ? "Uzav\u0159\xEDt p\u0159ipom\xEDnky" : "Otev\u0159\xEDt p\u0159ipom\xEDnky" })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("section", { className: "adminSection", children: [
          /* @__PURE__ */ jsx("div", { className: "adminSectionTitle", children: /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("h3", { children: "Dokument a odpov\u011Bdnost" }),
            /* @__PURE__ */ jsx("p", { children: "\xDAdaje, kter\xE9 \u010Dlenov\xE9 uvid\xED u normy." })
          ] }) }),
          /* @__PURE__ */ jsxs("div", { className: "adminControls twoColumns", children: [
            /* @__PURE__ */ jsxs("label", { children: [
              "P\u0159edkladatel",
              /* @__PURE__ */ jsx("input", { value: selectedNorm.submittedBy, onChange: (event) => actions.updateNorm?.(selectedNorm.id, { submittedBy: event.target.value }) })
            ] }),
            /* @__PURE__ */ jsxs("label", { children: [
              "Odpov\xEDd\xE1 za normu",
              /* @__PURE__ */ jsx("input", { value: selectedNorm.responsible, onChange: (event) => actions.updateNorm?.(selectedNorm.id, { responsible: event.target.value }) })
            ] }),
            /* @__PURE__ */ jsxs("label", { className: "wide", children: [
              "Pr\u016Fvodn\xED informace / d\u016Fvodov\xE1 zpr\xE1va",
              /* @__PURE__ */ jsx("textarea", { value: selectedNorm.reason, onChange: (event) => actions.updateNorm?.(selectedNorm.id, { reason: event.target.value }) })
            ] }),
            /* @__PURE__ */ jsxs("label", { className: "fileField wide", children: [
              /* @__PURE__ */ jsx("span", { children: selectedNorm.file ? `Nahr\xE1no: ${selectedNorm.file.name}` : "Nahr\xE1t PDF, DOCX nebo ODT" }),
              /* @__PURE__ */ jsx("input", { type: "file", accept: ".pdf,.docx,.odt", onChange: (event) => actions.replaceDocument?.(selectedNorm, event.target.files?.[0]) })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("section", { className: "adminSection", children: [
          /* @__PURE__ */ jsx("div", { className: "adminSectionTitle", children: /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("h3", { children: "Vypo\u0159\xE1d\xE1n\xED podn\u011Bt\u016F" }),
            /* @__PURE__ */ jsxs("p", { children: [
              selectedNorm.submissions.filter((item) => item.resolutionStatus === "Nevypo\u0159\xE1d\xE1no").length,
              " \u010Dek\xE1 na rozhodnut\xED."
            ] })
          ] }) }),
          /* @__PURE__ */ jsx("div", { className: "resolutionList", children: selectedNorm.submissions.length ? selectedNorm.submissions.map((item) => /* @__PURE__ */ jsxs("article", { className: "resolutionItem", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsxs("span", { children: [
                item.kind,
                " \xB7 ",
                item.section
              ] }),
              /* @__PURE__ */ jsx("h4", { children: item.title }),
              /* @__PURE__ */ jsx("p", { children: item.text }),
              /* @__PURE__ */ jsxs("small", { children: [
                item.author,
                ", ",
                item.unit,
                " \xB7 podpora ",
                item.score
              ] })
            ] }),
            /* @__PURE__ */ jsxs("form", { onSubmit: (event) => resolveSubmission(event, item.id), children: [
              /* @__PURE__ */ jsxs("label", { children: [
                "V\xFDsledek",
                /* @__PURE__ */ jsxs("select", { name: "resolutionStatus", defaultValue: item.resolutionStatus, children: [
                  /* @__PURE__ */ jsx("option", { children: "Nevypo\u0159\xE1d\xE1no" }),
                  /* @__PURE__ */ jsx("option", { children: "Zapracov\xE1no" }),
                  /* @__PURE__ */ jsx("option", { children: "Nezapracov\xE1no" })
                ] })
              ] }),
              /* @__PURE__ */ jsxs("label", { children: [
                "Od\u016Fvodn\u011Bn\xED rozhodnut\xED",
                /* @__PURE__ */ jsx("textarea", { name: "resolution", defaultValue: item.resolution, placeholder: "Popi\u0161te, jak a pro\u010D byl podn\u011Bt vypo\u0159\xE1d\xE1n." })
              ] }),
              /* @__PURE__ */ jsxs("label", { children: [
                "Koment\xE1\u0159 p\u0159edkladatele",
                /* @__PURE__ */ jsx("input", { name: "adminComment", defaultValue: item.adminComment, placeholder: "Voliteln\xE1 dopl\u0148uj\xEDc\xED odpov\u011B\u010F" })
              ] }),
              /* @__PURE__ */ jsx("button", { className: "primaryButton small", children: "Ulo\u017Eit vypo\u0159\xE1d\xE1n\xED" })
            ] }),
            /* @__PURE__ */ jsxs("form", { className: "adminReply", onSubmit: (event) => addReply(event, item.id), children: [
              /* @__PURE__ */ jsx("input", { name: "reply", placeholder: "Okomentovat podn\u011Bt jako p\u0159edkladatel\u2026", required: true }),
              /* @__PURE__ */ jsx("button", { children: "Odeslat koment\xE1\u0159" })
            ] })
          ] }, item.id)) : /* @__PURE__ */ jsx("div", { className: "emptyState", children: "U t\xE9to normy zat\xEDm nejsou \u017E\xE1dn\xE9 podn\u011Bty." }) })
        ] })
      ] }) : /* @__PURE__ */ jsx("div", { className: "emptyState", children: "Nejprve zalo\u017Ete novou normu." })
    ] })
  ] });
}
export {
  NormAdministration
};
