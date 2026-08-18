import { createElement as h } from "react";

function fullName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "Člen";
}

export function MemberProfile({ user, contributions = [], votes = [], actions = {} }) {
  if (!user) {
    return h("section", { className: "memberProfile" }, h("div", { className: "emptyState" }, "Profil je dostupný po přihlášení."));
  }
  const ownContributions = contributions.filter((item) => item.authorUserId === user.id);
  const ownVotes = votes.filter((item) => item.userId === user.id);

  async function changePassword(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const result = await actions.changePassword?.({
      currentPassword: String(form.get("currentPassword") || ""),
      newPassword: String(form.get("newPassword") || ""),
    });
    if (result) formElement.reset();
  }

  return h(
    "section",
    { className: "memberProfile" },
    h("header", { className: "memberProfileHeading" }, h("p", { className: "kicker" }, "Členský profil"), h("h1", null, fullName(user))),
    h("dl", { className: "memberProfileFacts", role: "region", "aria-label": "Členské údaje" },
      h("div", null, h("dt", null, "E-mail"), h("dd", null, user.email)),
      h("div", null, h("dt", null, "Jednota"), h("dd", null, user.sokolUnit)),
      h("div", null, h("dt", null, "Členské ID"), h("dd", null, user.membershipId)),
      h("div", null, h("dt", null, "Ověření e-mailu"), h("dd", null, user.emailVerifiedAt ? "Ověřený e-mail" : "E-mail není ověřen")),
    ),
    ["admin", "superadmin"].includes(user.role) && h(
      "section",
      { className: "passwordChange" },
      h("h2", null, "Změna hesla"),
      h("p", null, "Po změně hesla budou všechny relace zrušeny a přihlásíte se znovu."),
      h("form", { onSubmit: changePassword },
        h("label", null, "Současné heslo", h("input", { name: "currentPassword", type: "password", required: true })),
        h("label", null, "Nové heslo", h("input", { name: "newPassword", type: "password", required: true })),
        h("button", { className: "primaryButton" }, "Změnit heslo"),
      ),
    ),
    h("div", { className: "memberProfileActivity" },
      h("section", { "aria-labelledby": "profile-contributions" },
        h("h2", { id: "profile-contributions" }, "Moje příspěvky"),
        ownContributions.length
          ? h("ul", null, ownContributions.map((item) => h("li", { key: item.id }, h("span", null, item.kind), h("strong", null, item.title), h("small", null, item.normTitle))))
          : h("p", { className: "emptyState" }, "Zatím jste nepřidali žádný příspěvek."),
      ),
      h("section", { "aria-labelledby": "profile-votes" },
        h("h2", { id: "profile-votes" }, "Moje hlasy"),
        ownVotes.length
          ? h("ul", null, ownVotes.map((item) => h("li", { key: item.id }, h("strong", null, item.label), h("small", null, item.normTitle))))
          : h("p", { className: "emptyState" }, "Zatím jste nehlasovali."),
      ),
    ),
  );
}
