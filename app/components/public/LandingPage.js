import { Fragment, jsxs, jsx } from "react/jsx-runtime";
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
function LandingPage({ norms = [], filter = "Aktivn\xED", onFilter, onOpen }) {
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs("section", { className: "hero", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("p", { className: "kicker", children: "Participativn\xED tvorba sokolsk\xFDch norem" }),
        /* @__PURE__ */ jsx("h1", { children: "Rozhodujme spole\u010Dn\u011B." }),
        /* @__PURE__ */ jsx("p", { children: "P\u0159ipom\xEDnkujte n\xE1vrhy, pod\xE1vejte konkr\xE9tn\xED \xFApravy a sledujte, jak p\u0159edkladatel ka\u017Ed\xFD podn\u011Bt vypo\u0159\xE1dal." }),
        /* @__PURE__ */ jsx("button", { className: "primaryButton", onClick: () => document.getElementById("normy")?.scrollIntoView({ behavior: "smooth" }), children: "Zobrazit normy" })
      ] }),
      /* @__PURE__ */ jsxs("aside", { children: [
        /* @__PURE__ */ jsx("b", { children: "Jak to prob\xEDh\xE1" }),
        /* @__PURE__ */ jsxs("ol", { children: [
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("span", { children: "1" }),
            "P\u0159e\u010Dtete si materi\xE1l a d\u016Fvodovou zpr\xE1vu."
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("span", { children: "2" }),
            "P\u0159id\xE1te koment\xE1\u0159 nebo p\u0159esn\xFD n\xE1vrh zm\u011Bny."
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("span", { children: "3" }),
            "Hlasov\xE1n\xEDm podpo\u0159\xEDte d\u016Fle\u017Eit\xE9 podn\u011Bty."
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("span", { children: "4" }),
            "Uvid\xEDte rozhodnut\xED a od\u016Fvodn\u011Bn\xED p\u0159edkladatele."
          ] })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("section", { className: "normListSection", id: "normy", children: [
      /* @__PURE__ */ jsxs("div", { className: "sectionHeading", children: [
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("p", { className: "kicker", children: "Evidence materi\xE1l\u016F" }),
          /* @__PURE__ */ jsx("h2", { children: "Normy k p\u0159ipom\xEDnkov\xE1n\xED" })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "filterTabs", children: ["Aktivn\xED", "Uzav\u0159en\xE9", "V\u0161echny"].map((item) => /* @__PURE__ */ jsx("button", { className: filter === item ? "active" : "", "aria-pressed": filter === item, onClick: () => onFilter?.(item), children: item }, item)) })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "normGrid", children: norms.length ? norms.map(
        (norm) => norm.visibilityMode === "title-only" ? /* @__PURE__ */ jsxs("article", { className: "normCard", children: [
          /* @__PURE__ */ jsx("h3", { children: norm.title }),
          /* @__PURE__ */ jsx("p", { className: "summary", children: "Detail t\xE9to normy je dostupn\xFD po p\u0159ihl\xE1\u0161en\xED." }),
          /* @__PURE__ */ jsx("div", { className: "cardFooter", children: /* @__PURE__ */ jsx("button", { onClick: () => onOpen?.(norm.id), children: "Otev\u0159\xEDt materi\xE1l \u2192" }) })
        ] }, norm.id) : /* @__PURE__ */ jsxs("article", { className: "normCard", children: [
          /* @__PURE__ */ jsxs("div", { className: "cardTop", children: [
            /* @__PURE__ */ jsx("span", { className: "normNumber", children: norm.number }),
            /* @__PURE__ */ jsx(StatusBadge, { value: norm.status })
          ] }),
          /* @__PURE__ */ jsxs("p", { className: "category", children: [
            norm.category,
            " \xB7 verze ",
            norm.version
          ] }),
          /* @__PURE__ */ jsx("h3", { children: norm.title }),
          /* @__PURE__ */ jsx("p", { className: "summary", children: norm.summary }),
          /* @__PURE__ */ jsxs("dl", { children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("dt", { children: "P\u0159edkl\xE1d\xE1" }),
              /* @__PURE__ */ jsx("dd", { children: norm.submittedBy })
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("dt", { children: "Odpov\xEDd\xE1" }),
              /* @__PURE__ */ jsx("dd", { children: norm.responsible })
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("dt", { children: "P\u0159ipom\xEDnky" }),
              /* @__PURE__ */ jsx("dd", { children: norm.commentsOpen ? `do ${dateLabel(norm.deadline)}` : "uzav\u0159eny" })
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "cardFooter", children: [
            /* @__PURE__ */ jsxs("span", { children: [
              norm.submissions?.length || 0,
              " podn\u011Bt\u016F"
            ] }),
            /* @__PURE__ */ jsx("button", { onClick: () => onOpen?.(norm.id), children: "Otev\u0159\xEDt materi\xE1l \u2192" })
          ] })
        ] }, norm.id)
      ) : /* @__PURE__ */ jsx("div", { className: "emptyState", children: "V t\xE9to skupin\u011B zat\xEDm nejsou \u017E\xE1dn\xE9 normy." }) })
    ] })
  ] });
}
export {
  LandingPage
};
