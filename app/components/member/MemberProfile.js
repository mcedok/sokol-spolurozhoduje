import { jsxs, jsx } from "react/jsx-runtime";
function fullName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "\u010Clen";
}
function MemberProfile({ user, contributions = [], votes = [] }) {
  if (!user) {
    return /* @__PURE__ */ jsx("section", { className: "memberProfile", children: /* @__PURE__ */ jsx("div", { className: "emptyState", children: "Profil je dostupn\xFD po p\u0159ihl\xE1\u0161en\xED." }) });
  }
  const ownContributions = contributions.filter((item) => item.authorUserId === user.id);
  const ownVotes = votes.filter((item) => item.userId === user.id);
  return /* @__PURE__ */ jsxs("section", { className: "memberProfile", children: [
    /* @__PURE__ */ jsxs("header", { className: "memberProfileHeading", children: [
      /* @__PURE__ */ jsx("p", { className: "kicker", children: "\u010Clensk\xFD profil" }),
      /* @__PURE__ */ jsx("h1", { children: fullName(user) })
    ] }),
    /* @__PURE__ */ jsxs("dl", { className: "memberProfileFacts", role: "region", "aria-label": "\u010Clensk\xE9 \xFAdaje", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("dt", { children: "E-mail" }),
        /* @__PURE__ */ jsx("dd", { children: user.email })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("dt", { children: "Jednota" }),
        /* @__PURE__ */ jsx("dd", { children: user.sokolUnit })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("dt", { children: "\u010Clensk\xE9 ID" }),
        /* @__PURE__ */ jsx("dd", { children: user.membershipId })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("dt", { children: "Ov\u011B\u0159en\xED e-mailu" }),
        /* @__PURE__ */ jsx("dd", { children: user.emailVerifiedAt ? "Ov\u011B\u0159en\xFD e-mail" : "E-mail nen\xED ov\u011B\u0159en" })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "memberProfileActivity", children: [
      /* @__PURE__ */ jsxs("section", { "aria-labelledby": "profile-contributions", children: [
        /* @__PURE__ */ jsx("h2", { id: "profile-contributions", children: "Moje p\u0159\xEDsp\u011Bvky" }),
        ownContributions.length ? /* @__PURE__ */ jsx("ul", { children: ownContributions.map((item) => /* @__PURE__ */ jsxs("li", { children: [
          /* @__PURE__ */ jsx("span", { children: item.kind }),
          /* @__PURE__ */ jsx("strong", { children: item.title }),
          /* @__PURE__ */ jsx("small", { children: item.normTitle })
        ] }, item.id)) }) : /* @__PURE__ */ jsx("p", { className: "emptyState", children: "Zat\xEDm jste nep\u0159idali \u017E\xE1dn\xFD p\u0159\xEDsp\u011Bvek." })
      ] }),
      /* @__PURE__ */ jsxs("section", { "aria-labelledby": "profile-votes", children: [
        /* @__PURE__ */ jsx("h2", { id: "profile-votes", children: "Moje hlasy" }),
        ownVotes.length ? /* @__PURE__ */ jsx("ul", { children: ownVotes.map((item) => /* @__PURE__ */ jsxs("li", { children: [
          /* @__PURE__ */ jsx("strong", { children: item.label }),
          /* @__PURE__ */ jsx("small", { children: item.normTitle })
        ] }, item.id)) }) : /* @__PURE__ */ jsx("p", { className: "emptyState", children: "Zat\xEDm jste nehlasovali." })
      ] })
    ] })
  ] });
}
export {
  MemberProfile
};
