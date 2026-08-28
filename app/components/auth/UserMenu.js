import { createElement as h } from "react";

const ROLE_LABELS = {
  member: "Člen",
  admin: "Administrátor",
  superadmin: "Superadministrátor",
};

export function UserMenu({ currentUser, loginDisabled = false, onLogin, onProfile, onLogout }) {
  if (!currentUser) {
    return h(
      "div",
      { className: "userMenu signedOut" },
      h("button", {
        type: "button",
        className: "primaryButton small",
        disabled: loginDisabled,
        onClick: onLogin,
      }, "Přihlásit"),
    );
  }

  const fullName = `${currentUser.firstName || ""} ${currentUser.lastName || ""}`.trim();
  const initials = `${currentUser.firstName?.[0] || ""}${currentUser.lastName?.[0] || ""}` || "Ú";

  return h(
    "div",
    { className: "userMenu signedIn" },
    h("span", { className: "userAvatar", "aria-hidden": "true" }, initials.toUpperCase()),
    h("div", { className: "userIdentity" },
      h("strong", null, fullName),
      h("small", null, ROLE_LABELS[currentUser.role] || currentUser.role),
    ),
    h("div", { className: "userMenuActions" },
      h("button", { type: "button", onClick: onProfile }, "Profil"),
      h("button", { type: "button", onClick: onLogout }, "Odhlásit"),
    ),
  );
}
