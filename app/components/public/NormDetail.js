import { createElement as h } from "react";
import { StructuredBlockContent } from "../shared/StructuredBlockContent.js";

const STATUS_CLASSES = {
  Koncept: "neutral",
  "K připomínkování": "open",
  Vypořádání: "review",
  "Ke schválení": "review",
  Schváleno: "approved",
  Neschváleno: "rejected",
  Archivováno: "neutral",
};

function dateLabel(value) {
  if (!value) return "neuvedeno";
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function StatusBadge({ value }) {
  return h("span", { className: `statusBadge ${STATUS_CLASSES[value] || "neutral"}` }, value);
}

export function NormDetail({ norm, currentUser, permissions = {}, actions = {} }) {
  if (!norm) {
    return h("section", { className: "detailPage" }, h("div", { className: "emptyState" }, "Norma nebyla nalezena."));
  }
  const participationOpen = norm.commentsOpen && norm.status === "K připomínkování";

  function participate(intent, operation) {
    if (permissions.canParticipate) return operation?.();
    if (!currentUser) return actions.requireLogin?.(intent);
    return actions.showParticipationUnavailable?.(intent);
  }

  async function addReply(event, submission) {
    event.preventDefault();
    if (!permissions.canParticipate) return;
    const form = event.currentTarget;
    const text = String(new FormData(form).get("reply") || "").trim();
    if (!text) return;
    const result = await actions.addReply?.(
      norm.number,
      submission.id,
      text,
      norm.participationVersion,
    );
    if (result) form.reset();
  }

  if (norm.visibilityMode === "title-only") {
    return h(
      "section",
      { className: "detailPage" },
      h("button", { className: "backButton", onClick: actions.onBack }, "← Zpět na seznam norem"),
      h("div", { className: "detailHeader" },
        h("div", null, h("h1", null, norm.title), h("p", null, "Detail této normy je dostupný po přihlášení.")),
      ),
    );
  }

  return h(
    "section",
    { className: "detailPage" },
    h("button", { className: "backButton", onClick: actions.onBack }, "← Zpět na seznam norem"),
    h(
      "div",
      { className: "detailHeader" },
      h("div", null,
        h("div", { className: "detailMeta" },
          h("span", { className: "normNumber" }, norm.number),
          h(StatusBadge, { value: norm.status }),
        ),
        h("h1", null, norm.title),
        h("p", null, norm.summary),
      ),
      h("div", { className: "detailActions" },
        h("button", { onClick: () => actions.downloadDocument?.(norm) }, norm.file ? `Stáhnout ${norm.file.name}` : "Soubor není přiložen"),
        permissions.canManage && h("button", { className: "primaryButton small", onClick: () => actions.manage?.(norm.id) }, "Spravovat"),
      ),
    ),
    h("div", { className: "detailFacts" },
      h("div", null, h("span", null, "Předkládá"), h("b", null, norm.submittedBy)),
      h("div", null, h("span", null, "Za normu odpovídá"), h("b", null, norm.responsible)),
      h("div", null, h("span", null, "Zveřejněno"), h("b", null, dateLabel(norm.publishedAt))),
      h("div", null, h("span", null, "Termín"), h("b", null, dateLabel(norm.deadline))),
    ),
    h(
      "div",
      { className: "detailLayout" },
      h(
        "div",
        { className: "documentColumn" },
        h("section", { className: "reasonBox" },
          h("p", { className: "kicker" }, "Průvodní informace / důvodová zpráva"),
          h("h2", null, "Proč se norma mění"),
          h("p", null, norm.reason),
        ),
        h(
          "div",
          { className: "documentPaper" },
          h("p", { className: "documentLabel" }, `${norm.category} · verze ${norm.version}`),
          h("h2", null, norm.title),
          ...(norm.content || []).map((block, index) => h(
            "article",
            { className: "publicDocumentBlock", id: `block-${block.blockUid}`, key: block.blockUid },
            h("small", { className: "blockLabel" }, `Blok ${index + 1}`),
            h(StructuredBlockContent, { block }),
            block.commentable && participationOpen && h("div", { className: "blockParticipationActions" },
              h("button", {
                type: "button",
                "aria-label": `Přidat komentář k bloku ${index + 1}`,
                onClick: () => participate("comment", () => actions.openContribution?.("comment", block)),
              }, "Komentovat"),
              h("button", {
                type: "button",
                className: "primaryButton small",
                "aria-label": `Navrhnout změnu k bloku ${index + 1}`,
                onClick: () => participate("proposal", () => actions.openContribution?.("proposal", block)),
              }, "Navrhnout změnu"),
            ),
          )),
          ...(norm.sections || []).map((section) => h(
            "section",
            { className: "documentSection", key: section.id },
            h("div", null, h("b", null, section.label), h("h3", null, section.title)),
            ...(section.paragraphs || []).map((paragraph, index) => h(
              "p",
              { key: `${section.id}-${index}` },
              h("span", null, `(${index + 1})`),
              paragraph,
            )),
          )),
          h(
            "div",
            { className: "needVote" },
            h("div", null,
              h("b", null, "Je přijetí této normy potřebné?"),
              h("p", null, "Orientační hlasování členů není konečným schválením normy."),
            ),
            participationOpen
              ? h("div", null,
                h("button", {
                  className: permissions.needVote === "yes" ? "selected yes" : "",
                  "aria-pressed": permissions.needVote === "yes",
                  onClick: () => participate("vote-need", () => actions.voteNeed?.(norm.number, "yes", norm.participationVersion)),
                }, `Ano ${norm.needVotes?.yes || 0}`),
                h("button", {
                  className: permissions.needVote === "no" ? "selected no" : "",
                  "aria-pressed": permissions.needVote === "no",
                  onClick: () => participate("vote-need", () => actions.voteNeed?.(norm.number, "no", norm.participationVersion)),
                }, `Ne ${norm.needVotes?.no || 0}`),
              )
              : h("p", { className: "voteResults" }, `Výsledek: ano ${norm.needVotes?.yes || 0}, ne ${norm.needVotes?.no || 0}`),
          ),
        ),
      ),
      h(
        "aside",
        { className: "contributions" },
        h("div", { className: "contributionHeader" },
          h("div", null, h("p", { className: "kicker" }, "Diskuse"), h("h2", null, "Podněty členů")),
          participationOpen && !(norm.content || []).length && h("div", null,
            h("button", { onClick: () => participate("comment", () => actions.openContribution?.("comment")) }, "Komentář"),
            h("button", { className: "primaryButton small", onClick: () => participate("proposal", () => actions.openContribution?.("proposal")) }, "Návrh změny"),
          ),
        ),
        !participationOpen && h("div", { className: "closedNotice" }, "Aktivní připomínkování je uzavřeno. Výsledky zůstávají veřejné."),
        (norm.submissions || []).length
          ? norm.submissions.slice().sort((a, b) => b.score - a.score).map((item) => h(
            "article",
            { className: "submissionCard", key: item.id },
            h("div", { className: "submissionTop" }, h("span", null, item.kind), h("small", null, item.section)),
            h("h3", null, item.title),
            h("p", null, item.text),
            h("div", { className: "authorLine" }, h("b", null, item.author), h("span", null, `${item.unit} · ${dateLabel(item.createdAt)}`)),
            item.resolutionStatus !== "Nevypořádáno" && h(
              "div",
              { className: `resolutionBox ${item.resolutionStatus === "Zapracováno" ? "accepted" : "declined"}` },
              h("b", null, item.resolutionStatus),
              h("p", null, item.resolution),
              item.adminComment && h("small", null, `Předkladatel: ${item.adminComment}`),
            ),
            ...(item.replies || []).map((reply) => h("div", { className: "reply", key: reply.id }, h("b", null, reply.author), h("p", null, reply.text))),
            permissions.canParticipate && h("form", { className: "replyForm", onSubmit: (event) => addReply(event, item) },
              h("input", {
                name: "reply",
                "aria-label": permissions.canManage ? "Odpověď předkladatele" : "Odpověď ve vlákně",
                placeholder: permissions.canManage ? "Odpovědět jako předkladatel…" : "Odpovědět ve vlákně…",
                required: true,
              }),
              h("button", null, "Odeslat"),
            ),
            participationOpen
              ? h("div", { className: "voteRow" },
                h("span", null, "Je tento podnět důležitý?"),
                h("div", null,
                  h("button", {
                    className: permissions.submissionVote?.(item.id) === 1 ? "selected" : "",
                    "aria-label": "↑",
                    "aria-pressed": permissions.submissionVote?.(item.id) === 1,
                    onClick: () => participate("vote-submission", () => actions.voteSubmission?.(
                      norm.number, item.id, 1, item.rowVersion, norm.participationVersion,
                    )),
                  }, "↑"),
                  h("b", null, item.score),
                  h("button", {
                    className: permissions.submissionVote?.(item.id) === -1 ? "selected down" : "",
                    "aria-label": "↓",
                    "aria-pressed": permissions.submissionVote?.(item.id) === -1,
                    onClick: () => participate("vote-submission", () => actions.voteSubmission?.(
                      norm.number, item.id, -1, item.rowVersion, norm.participationVersion,
                    )),
                  }, "↓"),
                ),
              )
              : h("div", { className: "voteRow closed" }, h("span", null, "Výsledná důležitost podnětu"), h("b", null, item.score)),
          ))
          : h("div", { className: "emptyState" }, "Zatím nebyl přidán žádný podnět."),
      ),
    ),
  );
}
