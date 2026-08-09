import { jsxs, jsx } from "react/jsx-runtime";
const STATUS_CLASSES = {
  Koncept: "neutral",
  "K p\u0159ipom\xEDnkov\xE1n\xED": "open",
  Vypo\u0159\u00E1d\u00E1n\u00ED: "review",
  "Ke schv\xE1len\xED": "review",
  Schv\u00E1leno: "approved",
  Neschv\u00E1leno: "rejected",
  Archivov\u00E1no: "neutral"
};
function dateLabel(value) {
  if (!value) return "neuvedeno";
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(/* @__PURE__ */ new Date(`${value}T12:00:00`));
}
function StatusBadge({ value }) {
  return /* @__PURE__ */ jsx("span", { className: `statusBadge ${STATUS_CLASSES[value] || "neutral"}`, children: value });
}
function NormDetail({ norm, currentUser, permissions = {}, actions = {} }) {
  if (!norm) return /* @__PURE__ */ jsx("section", { className: "detailPage", children: /* @__PURE__ */ jsx("div", { className: "emptyState", children: "Norma nebyla nalezena." }) });
  function participate(intent, operation) {
    if (permissions.canParticipate) return operation?.();
    if (!currentUser) return actions.requireLogin?.(intent);
    return actions.showParticipationUnavailable?.(intent);
  }
  async function addReply(event, submissionId) {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get("reply") || "").trim();
    if (!text) return;
    const result = await participate(
      "reply",
      () => actions.addReply?.(norm.id, submissionId, text)
    );
    if (result) form.reset();
  }
  if (norm.visibilityMode === "title-only") {
    return /* @__PURE__ */ jsxs("section", { className: "detailPage", children: [
      /* @__PURE__ */ jsx("button", { className: "backButton", onClick: actions.onBack, children: "\u2190 Zp\u011Bt na seznam norem" }),
      /* @__PURE__ */ jsx("div", { className: "detailHeader", children: /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h1", { children: norm.title }),
        /* @__PURE__ */ jsx("p", { children: "Detail t\xE9to normy je dostupn\xFD po p\u0159ihl\xE1\u0161en\xED." })
      ] }) })
    ] });
  }
  return /* @__PURE__ */ jsxs("section", { className: "detailPage", children: [
    /* @__PURE__ */ jsx("button", { className: "backButton", onClick: actions.onBack, children: "\u2190 Zp\u011Bt na seznam norem" }),
    /* @__PURE__ */ jsxs("div", { className: "detailHeader", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsxs("div", { className: "detailMeta", children: [
          /* @__PURE__ */ jsx("span", { className: "normNumber", children: norm.number }),
          /* @__PURE__ */ jsx(StatusBadge, { value: norm.status })
        ] }),
        /* @__PURE__ */ jsx("h1", { children: norm.title }),
        /* @__PURE__ */ jsx("p", { children: norm.summary })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "detailActions", children: [
        /* @__PURE__ */ jsx("button", { onClick: () => actions.downloadDocument?.(norm), children: norm.file ? `St\xE1hnout ${norm.file.name}` : "Soubor nen\xED p\u0159ilo\u017Een" }),
        permissions.canManage && /* @__PURE__ */ jsx("button", { className: "primaryButton small", onClick: () => actions.manage?.(norm.id), children: "Spravovat" })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "detailFacts", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("span", { children: "P\u0159edkl\xE1d\xE1" }),
        /* @__PURE__ */ jsx("b", { children: norm.submittedBy })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("span", { children: "Za normu odpov\xEDd\xE1" }),
        /* @__PURE__ */ jsx("b", { children: norm.responsible })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("span", { children: "Zve\u0159ejn\u011Bno" }),
        /* @__PURE__ */ jsx("b", { children: dateLabel(norm.publishedAt) })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("span", { children: "Term\xEDn" }),
        /* @__PURE__ */ jsx("b", { children: dateLabel(norm.deadline) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "detailLayout", children: [
      /* @__PURE__ */ jsxs("div", { className: "documentColumn", children: [
        /* @__PURE__ */ jsxs("section", { className: "reasonBox", children: [
          /* @__PURE__ */ jsx("p", { className: "kicker", children: "Pr\u016Fvodn\xED informace / d\u016Fvodov\xE1 zpr\xE1va" }),
          /* @__PURE__ */ jsx("h2", { children: "Pro\u010D se norma m\u011Bn\xED" }),
          /* @__PURE__ */ jsx("p", { children: norm.reason })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "documentPaper", children: [
          /* @__PURE__ */ jsxs("p", { className: "documentLabel", children: [
            norm.category,
            " \xB7 verze ",
            norm.version
          ] }),
          /* @__PURE__ */ jsx("h2", { children: norm.title }),
          (norm.sections || []).map((section) => /* @__PURE__ */ jsxs("section", { className: "documentSection", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("b", { children: section.label }),
              /* @__PURE__ */ jsx("h3", { children: section.title })
            ] }),
            (section.paragraphs || []).map((paragraph, index) => /* @__PURE__ */ jsxs("p", { children: [
              /* @__PURE__ */ jsxs("span", { children: [
                "(",
                index + 1,
                ")"
              ] }),
              paragraph
            ] }, `${section.id}-${index}`))
          ] }, section.id)),
          /* @__PURE__ */ jsxs("div", { className: "needVote", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("b", { children: "Je p\u0159ijet\xED t\xE9to normy pot\u0159ebn\xE9?" }),
              /* @__PURE__ */ jsx("p", { children: "Orienta\u010Dn\xED hlasov\xE1n\xED \u010Dlen\u016F nen\xED kone\u010Dn\xFDm schv\xE1len\xEDm normy." })
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsxs("button", { onClick: () => participate("vote-need", () => actions.voteNeed?.(norm.id, "yes")), children: [
                "Ano ",
                norm.needVotes?.yes || 0
              ] }),
              /* @__PURE__ */ jsxs("button", { onClick: () => participate("vote-need", () => actions.voteNeed?.(norm.id, "no")), children: [
                "Ne ",
                norm.needVotes?.no || 0
              ] })
            ] })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("aside", { className: "contributions", children: [
        /* @__PURE__ */ jsxs("div", { className: "contributionHeader", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("p", { className: "kicker", children: "Diskuse" }),
            /* @__PURE__ */ jsx("h2", { children: "Podn\u011Bty \u010Dlen\u016F" })
          ] }),
          norm.commentsOpen && /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("button", { onClick: () => participate("comment", () => actions.openContribution?.("comment")), children: "Koment\xE1\u0159" }),
            /* @__PURE__ */ jsx("button", { className: "primaryButton small", onClick: () => participate("proposal", () => actions.openContribution?.("proposal")), children: "N\xE1vrh zm\u011Bny" })
          ] })
        ] }),
        !norm.commentsOpen && /* @__PURE__ */ jsx("div", { className: "closedNotice", children: "P\u0159ipom\xEDnkov\xE1n\xED je uzav\u0159eno. V\xFDsledky z\u016Fst\xE1vaj\xED ve\u0159ejn\xE9." }),
        (norm.submissions || []).length ? norm.submissions.slice().sort((a, b) => b.score - a.score).map((item) => /* @__PURE__ */ jsxs("article", { className: "submissionCard", children: [
          /* @__PURE__ */ jsxs("div", { className: "submissionTop", children: [
            /* @__PURE__ */ jsx("span", { children: item.kind }),
            /* @__PURE__ */ jsx("small", { children: item.section })
          ] }),
          /* @__PURE__ */ jsx("h3", { children: item.title }),
          /* @__PURE__ */ jsx("p", { children: item.text }),
          /* @__PURE__ */ jsxs("div", { className: "authorLine", children: [
            /* @__PURE__ */ jsx("b", { children: item.author }),
            /* @__PURE__ */ jsxs("span", { children: [
              item.unit,
              " \xB7 ",
              dateLabel(item.createdAt)
            ] })
          ] }),
          item.resolutionStatus !== "Nevypo\u0159\xE1d\xE1no" && /* @__PURE__ */ jsxs("div", { className: `resolutionBox ${item.resolutionStatus === "Zapracov\xE1no" ? "accepted" : "declined"}`, children: [
            /* @__PURE__ */ jsx("b", { children: item.resolutionStatus }),
            /* @__PURE__ */ jsx("p", { children: item.resolution }),
            item.adminComment && /* @__PURE__ */ jsxs("small", { children: [
              "P\u0159edkladatel: ",
              item.adminComment
            ] })
          ] }),
          (item.replies || []).map((reply) => /* @__PURE__ */ jsxs("div", { className: "reply", children: [
            /* @__PURE__ */ jsx("b", { children: reply.author }),
            /* @__PURE__ */ jsx("p", { children: reply.text })
          ] }, reply.id)),
          norm.commentsOpen && /* @__PURE__ */ jsxs("form", { className: "replyForm", onSubmit: (event) => addReply(event, item.id), children: [
            /* @__PURE__ */ jsx("input", { name: "reply", "aria-label": "Odpov\u011B\u010F", placeholder: "Odpov\u011Bd\u011Bt\u2026", required: true }),
            /* @__PURE__ */ jsx("button", { children: "Odeslat" })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "voteRow", children: [
            /* @__PURE__ */ jsx("span", { children: "Je tento podn\u011Bt d\u016Fle\u017Eit\xFD?" }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("button", { "aria-label": "\u2191", onClick: () => participate("vote-submission", () => actions.voteSubmission?.(norm.id, item.id, 1)), children: "\u2191" }),
              /* @__PURE__ */ jsx("b", { children: item.score }),
              /* @__PURE__ */ jsx("button", { "aria-label": "\u2193", onClick: () => participate("vote-submission", () => actions.voteSubmission?.(norm.id, item.id, -1)), children: "\u2193" })
            ] })
          ] })
        ] }, item.id)) : /* @__PURE__ */ jsx("div", { className: "emptyState", children: "Zat\xEDm nebyl p\u0159id\xE1n \u017E\xE1dn\xFD podn\u011Bt." })
      ] })
    ] })
  ] });
}
export {
  NormDetail
};
