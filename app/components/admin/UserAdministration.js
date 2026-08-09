import { createElement as h, useEffect, useRef, useState } from "react";
import { DemoInbox } from "../auth/DemoInbox.js";
import { ROLE, USER_STATUS } from "../../domain/constants.js";
import { useDialogFocusTrap } from "../../hooks/use-dialog-focus-trap.js";

const ROLE_LABELS = {
  [ROLE.MEMBER]: "Člen",
  [ROLE.ADMIN]: "Administrátor",
  [ROLE.SUPERADMIN]: "Superadministrátor",
};

const STATUS_LABELS = {
  [USER_STATUS.ACTIVE]: "Aktivní",
  [USER_STATUS.INVITED]: "Pozvaný",
  [USER_STATUS.PENDING]: "Čeká na ověření",
  [USER_STATUS.BLOCKED]: "Blokovaný",
};

const AUDIT_LABELS = {
  "user.created": "uživatelský účet vytvořen",
  "user.status_changed": "stav účtu změněn",
  "user.role_changed": "role účtu změněna",
};

function fullName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ");
}

function lastLoginLabel(value) {
  if (!value) return "Dosud neproběhlo";
  return new Intl.DateTimeFormat("cs-CZ", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function SummaryCard({ label, value }) {
  return h(
    "article",
    { className: "userSummaryCard" },
    h("span", null, label),
    h("strong", null, String(value || 0)),
  );
}

function FilterBar({ filters = {}, onChange }) {
  return h(
    "div",
    { className: "userFilters" },
    h(
      "label",
      { className: "userSearch" },
      h("span", null, "Hledat uživatele"),
      h("input", {
        type: "search",
        value: filters.query || "",
        placeholder: "Jméno, e-mail, jednota nebo členské ID",
        onChange: (event) => onChange?.({ query: event.target.value }),
      }),
    ),
    h(
      "label",
      null,
      h("span", null, "Role"),
      h(
        "select",
        {
          value: filters.role || "",
          onChange: (event) => onChange?.({ role: event.target.value }),
        },
        h("option", { value: "" }, "Všechny role"),
        h("option", { value: ROLE.MEMBER }, "Člen"),
        h("option", { value: ROLE.ADMIN }, "Administrátor"),
        h("option", { value: ROLE.SUPERADMIN }, "Superadministrátor"),
      ),
    ),
    h(
      "label",
      null,
      h("span", null, "Stav"),
      h(
        "select",
        {
          value: filters.status || "",
          onChange: (event) => onChange?.({ status: event.target.value }),
        },
        h("option", { value: "" }, "Všechny stavy"),
        h("option", { value: USER_STATUS.ACTIVE }, "Aktivní"),
        h("option", { value: USER_STATUS.INVITED }, "Pozvaní"),
        h("option", { value: USER_STATUS.PENDING }, "Čeká na ověření"),
        h("option", { value: USER_STATUS.BLOCKED }, "Blokovaní"),
      ),
    ),
  );
}

function UserTable({ users, selectedUser, onSelect }) {
  return h(
    "div",
    { className: "userTableWrap" },
    h(
      "table",
      { className: "userTable", "aria-label": "Uživatelé" },
      h(
        "thead",
        { role: "rowgroup" },
        h(
          "tr",
          { role: "row" },
          h("th", { scope: "col", role: "columnheader" }, "Uživatel"),
          h("th", { scope: "col", role: "columnheader" }, "Jednota / členské ID"),
          h("th", { scope: "col", role: "columnheader" }, "Role"),
          h("th", { scope: "col", role: "columnheader" }, "Stav"),
          h("th", { scope: "col", role: "columnheader" }, "Poslední přihlášení"),
        ),
      ),
      h(
        "tbody",
        { role: "rowgroup" },
        users.length
          ? users.map((user) =>
            h(
              "tr",
              { key: user.id, role: "row", className: selectedUser?.id === user.id ? "selected" : "" },
              h(
                "th",
                { scope: "row", role: "rowheader" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "userRowButton",
                    "aria-pressed": selectedUser?.id === user.id,
                    onClick: () => onSelect?.(user.id),
                  },
                  h(
                    "span",
                    { className: "srOnly" },
                    `Otevřít detail ${fullName(user)}; ${user.email}; ${user.sokolUnit}; ${user.membershipId}; ${ROLE_LABELS[user.role] || user.role}; ${STATUS_LABELS[user.status] || user.status}`,
                  ),
                  h("strong", { "aria-hidden": true }, fullName(user)),
                  h("span", { "aria-hidden": true }, user.email),
                ),
              ),
              h("td", { role: "cell", "data-label": "Jednota / členské ID" }, h("span", null, user.sokolUnit), h("small", null, user.membershipId)),
              h("td", { role: "cell", "data-label": "Role" }, h("span", { className: `userRole ${user.role}` }, ROLE_LABELS[user.role] || user.role)),
              h("td", { role: "cell", "data-label": "Stav" }, h("span", { className: `userStatus ${user.status}` }, STATUS_LABELS[user.status] || user.status)),
              h("td", { role: "cell", "data-label": "Poslední přihlášení" }, lastLoginLabel(user.lastLoginAt)),
            ),
          )
          : h("tr", { role: "row" }, h("td", { role: "cell", colSpan: 5, className: "userTableEmpty" }, "Filtru neodpovídá žádný uživatel.")),
      ),
    ),
  );
}

function UserManagementActions({ user, actions }) {
  const [role, setRole] = useState(user.role);
  const [transferUserId, setTransferUserId] = useState("");
  const [error, setError] = useState("");
  const [statusPending, setStatusPending] = useState(false);
  const demotingOwner =
    role === ROLE.MEMBER &&
    [ROLE.ADMIN, ROLE.SUPERADMIN].includes(user.role) &&
    user.ownedNormCount > 0;

  useEffect(() => {
    setRole(user.role);
    setTransferUserId("");
    setError("");
  }, [user.id, user.role]);

  async function changeStatus() {
    if (statusPending) return;
    const nextStatus = user.status === USER_STATUS.BLOCKED ? USER_STATUS.ACTIVE : USER_STATUS.BLOCKED;
    if (
      nextStatus === USER_STATUS.BLOCKED &&
      !window.confirm("Blokace účtu zruší všechny aktivní relace. Chcete pokračovat?")
    ) return;
    setStatusPending(true);
    try {
      await actions.setUserStatus?.(user.id, nextStatus);
    } finally {
      setStatusPending(false);
    }
  }

  async function submitRole(event) {
    event.preventDefault();
    setError("");
    if (role === user.role) return;
    if (demotingOwner && !transferUserId) {
      setError("Vyberte nového vlastníka norem.");
      return;
    }
    const confirmation = demotingOwner
      ? "Změna role převede vlastnictví norem a zruší aktivní relace. Chcete pokračovat?"
      : "Změna role zruší všechny aktivní relace uživatele. Chcete pokračovat?";
    if (!window.confirm(confirmation)) return;
    await actions.changeUserRole?.(user.id, role, transferUserId || undefined);
  }

  return h(
    "section",
    { className: "userManagementActions" },
    h("h3", null, "Přístup a role"),
    h(
      "button",
      {
        type: "button",
        className: user.status === USER_STATUS.BLOCKED ? "primaryButton small" : "dangerButton",
        disabled: statusPending,
        "aria-busy": statusPending,
        onClick: changeStatus,
      },
      statusPending
        ? user.status === USER_STATUS.BLOCKED
          ? "Aktivace probíhá…"
          : "Blokace probíhá…"
        : user.status === USER_STATUS.BLOCKED
          ? "Aktivovat účet"
          : "Blokovat účet",
    ),
    h(
      "form",
      { onSubmit: submitRole },
      h(
        "label",
        null,
        h("span", null, "Role účtu"),
        h(
          "select",
          { value: role, onChange: (event) => setRole(event.target.value) },
          h("option", { value: ROLE.MEMBER }, "Člen"),
          h("option", { value: ROLE.ADMIN }, "Administrátor"),
          h("option", { value: ROLE.SUPERADMIN }, "Superadministrátor"),
        ),
      ),
      demotingOwner && h(
        "label",
        null,
        h("span", null, "Nový vlastník norem"),
        h(
          "select",
          { value: transferUserId, onChange: (event) => setTransferUserId(event.target.value) },
          h("option", { value: "" }, "Vyberte aktivního správce"),
          ...(actions.transferCandidates || [])
            .filter((candidate) => candidate.id !== user.id)
            .map((candidate) => h("option", { key: candidate.id, value: candidate.id }, fullName(candidate))),
        ),
      ),
      error && h("p", { className: "userActionError", role: "alert" }, error),
      h("button", { type: "submit" }, "Uložit roli"),
    ),
  );
}

function UserDetail({ user, auditEvents, actions }) {
  if (!user) {
    return h(
      "aside",
      { className: "userDetailPanel empty" },
      h("p", null, "Vyberte uživatele v tabulce a zobrazte jeho detail."),
    );
  }

  return h(
    "aside",
    { className: "userDetailPanel", "aria-label": `Detail ${fullName(user)}` },
    h("button", { type: "button", className: "userDetailBack", onClick: () => actions.selectUser?.(null) }, "← Zpět na seznam"),
    h("p", { className: "kicker" }, ROLE_LABELS[user.role] || user.role),
    h("h2", null, fullName(user)),
    h(
      "dl",
      { className: "userFacts" },
      h("div", null, h("dt", null, "E-mail"), h("dd", null, user.email)),
      h("div", null, h("dt", null, "Jednota"), h("dd", null, user.sokolUnit)),
      h("div", null, h("dt", null, "Členské ID"), h("dd", null, user.membershipId)),
      h("div", null, h("dt", null, "Stav"), h("dd", null, STATUS_LABELS[user.status] || user.status)),
    ),
    h(UserManagementActions, { user, actions }),
    h(
      "section",
      { className: "userAudit" },
      h("h3", null, "Auditní historie"),
      auditEvents.length
        ? h(
          "ol",
          null,
          auditEvents.map((event, index) =>
            h(
              "li",
              { key: `${event.createdAt || "event"}-${index}` },
              h("strong", null, AUDIT_LABELS[event.action] || event.action),
              h("time", { dateTime: event.createdAt }, event.createdAt ? new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.createdAt)) : ""),
            ),
          ),
        )
        : h("p", null, "Zatím bez auditních událostí."),
    ),
  );
}

function CreateUserDialog({ onClose, onCreate }) {
  const firstFieldRef = useRef(null);
  const dialogRef = useDialogFocusTrap({ onClose });

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  async function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await onCreate?.({
      firstName: String(data.get("firstName") || "").trim(),
      lastName: String(data.get("lastName") || "").trim(),
      email: String(data.get("email") || "").trim(),
      sokolUnit: String(data.get("sokolUnit") || "").trim(),
      membershipId: String(data.get("membershipId") || "").trim(),
      role: String(data.get("role") || ROLE.ADMIN),
    });
    if (result) onClose?.();
  }

  return h(
    "div",
    { className: "modalBackdrop", onMouseDown: onClose },
    h(
      "form",
      {
        className: "modal",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "create-user-title",
        ref: dialogRef,
        onSubmit: submit,
        onMouseDown: (event) => event.stopPropagation(),
      },
      h("button", { type: "button", className: "modalClose", "aria-label": "Zavřít", onClick: onClose }, "×"),
      h("p", { className: "kicker" }, "Nový privilegovaný účet"),
      h("h2", { id: "create-user-title" }, "Vytvořit administrátora"),
      h("label", null, "Jméno", h("input", { name: "firstName", required: true, ref: firstFieldRef })),
      h("label", null, "Příjmení", h("input", { name: "lastName", required: true })),
      h("label", null, "E-mail", h("input", { name: "email", type: "email", required: true })),
      h("label", null, "Tělocvičná jednota", h("input", { name: "sokolUnit", required: true })),
      h("label", null, "Členské ID", h("input", { name: "membershipId", required: true })),
      h(
        "label",
        null,
        "Role",
        h(
          "select",
          { name: "role", defaultValue: ROLE.ADMIN },
          h("option", { value: ROLE.ADMIN }, "Administrátor"),
          h("option", { value: ROLE.SUPERADMIN }, "Superadministrátor"),
        ),
      ),
      h(
        "div",
        { className: "modalActions" },
        h("button", { type: "button", onClick: onClose }, "Zrušit"),
        h("button", { className: "primaryButton" }, "Vytvořit administrátora"),
      ),
    ),
  );
}

export function canAccessUserAdministration(user) {
  return user?.role === ROLE.SUPERADMIN && user.status === USER_STATUS.ACTIVE;
}

export function UserAdministration({
  currentUser,
  users = [],
  selectedUser,
  auditEvents = [],
  summary = {},
  filters = {},
  setupDeliveries = [],
  actions = {},
}) {
  const [showCreate, setShowCreate] = useState(false);
  if (!canAccessUserAdministration(currentUser)) {
    return h(
      "section",
      { className: "userAdministration unauthorized", role: "alert" },
      h("h1", null, "Nemáte oprávnění spravovat uživatele"),
      h("p", null, "Tato část je dostupná pouze aktivnímu superadministrátorovi."),
    );
  }
  return h(
    "section",
    { className: "userAdministration" },
    h(
      "header",
      { className: "userAdministrationHeading" },
      h("div", null, h("p", { className: "kicker" }, "Superadministrace"), h("h1", null, "Uživatelé"), h("p", null, "Správa přístupů, rolí a vlastnictví norem.")),
      h("button", { type: "button", className: "primaryButton", onClick: () => setShowCreate(true) }, "Nový administrátor"),
    ),
    h(
      "div",
      { className: "userSummary", role: "region", "aria-label": "Souhrn stavů" },
      h(SummaryCard, { label: "Aktivní", value: summary.active }),
      h(SummaryCard, { label: "Pozvaní", value: summary.invited }),
      h(SummaryCard, { label: "Blokovaní", value: summary.blocked }),
    ),
    h(
      "p",
      { className: "demoBoundary", role: "note" },
      "Lokální demoverze: data zůstávají pouze v tomto profilu prohlížeče. Produkční správa uživatelů vyžaduje serverovou databázi a autorizaci.",
    ),
    h(DemoInbox, {
      deliveries: setupDeliveries,
      onOpenLink: actions.openSetupDelivery,
    }),
    h(FilterBar, { filters, onChange: actions.setFilters }),
    h(
      "div",
      { className: `userAdministrationLayout${selectedUser ? " hasDetail" : ""}` },
      h(UserTable, { users, selectedUser, onSelect: actions.selectUser }),
      h(UserDetail, { key: selectedUser?.id || "empty", user: selectedUser, auditEvents, actions }),
    ),
    showCreate && h(CreateUserDialog, { onClose: () => setShowCreate(false), onCreate: actions.createUser }),
  );
}
