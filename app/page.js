"use client";
import { jsxs, jsx } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { NormAdministration } from "./components/admin/NormAdministration.js";
import {
  canAccessUserAdministration,
  UserAdministration
} from "./components/admin/UserAdministration.js";
import { AuthDialog } from "./components/auth/AuthDialog.js";
import { UserMenu } from "./components/auth/UserMenu.js";
import { MemberProfile } from "./components/member/MemberProfile.js";
import { LandingPage } from "./components/public/LandingPage.js";
import { NormDetail } from "./components/public/NormDetail.js";
import { Feedback } from "./components/shared/Feedback.js";
import { createInitialState } from "./domain/demo-data.js";
import { useAppController } from "./hooks/use-app-controller.js";
const STATUS_OPTIONS = [
  "Koncept",
  "K p\u0159ipom\xEDnkov\xE1n\xED",
  "Vypo\u0159\xE1d\xE1n\xED",
  "Ke schv\xE1len\xED",
  "Schv\xE1leno",
  "Neschv\xE1leno",
  "Archivov\xE1no"
];
const initialNormId = createInitialState().norms[0]?.id || "";
function Home() {
  const controller = useAppController();
  const {
    session,
    currentUser,
    view,
    actions,
    feedback,
    authMode,
    authDelivery,
    services,
    normCatalog,
    normAdministration,
    memberProfile,
    userAdministration
  } = controller;
  const [selectedId, setSelectedId] = useState(initialNormId);
  const [adminId, setAdminId] = useState(initialNormId);
  const [submissionMode, setSubmissionMode] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const selectedNorm = useMemo(
    () => normCatalog.allNorms.find((norm) => norm.id === selectedId) || normCatalog.allNorms[0],
    [normCatalog.allNorms, selectedId]
  );
  const adminNorm = useMemo(
    () => normAdministration.norms.find((norm) => norm.id === adminId) || normAdministration.norms[0],
    [adminId, normAdministration.norms]
  );
  function scrollToTop() {
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }
  function openNorm(id) {
    if (id) setSelectedId(id);
    actions.setView("detail");
    scrollToTop();
  }
  function openAdmin(id = adminId) {
    if (!session?.id) {
      normCatalog.actions.requireLogin("administration");
      return;
    }
    if (id) setAdminId(id);
    actions.setView("admin");
    scrollToTop();
  }
  async function submitContribution(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await normCatalog.actions.addContribution(selectedNorm.id, {
      kind: submissionMode === "proposal" ? "N\xE1vrh \xFApravy" : "Koment\xE1\u0159",
      section: String(form.get("section") || "").trim() || "Obecn\u011B",
      title: String(form.get("title") || "").trim(),
      text: String(form.get("text") || "").trim()
    });
    if (result) setSubmissionMode(null);
  }
  async function createNorm(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    const result = await normCatalog.actions.createNorm({
      title: String(form.get("title") || "").trim(),
      category: String(form.get("category") || "").trim(),
      version: String(form.get("version") || "").trim(),
      status: String(form.get("status") || ""),
      deadline: String(form.get("deadline") || ""),
      submittedBy: String(form.get("submittedBy") || "").trim(),
      responsible: String(form.get("responsible") || "").trim(),
      summary: String(form.get("summary") || "").trim(),
      reason: String(form.get("reason") || "").trim()
    }, file instanceof File && file.size > 0 ? file : void 0);
    if (!result) return;
    setAdminId(result.norm.id);
    setSelectedId(result.norm.id);
    setShowCreate(false);
  }
  async function deleteNorm(norm) {
    const result = await normCatalog.actions.deleteNorm(norm);
    if (!result) return;
    const fallback = normAdministration.norms.find((candidate) => candidate.id !== norm.id);
    setAdminId(fallback?.id || "");
    setSelectedId(fallback?.id || "");
  }
  const detailActions = {
    ...normCatalog.actions,
    onBack: () => actions.setView("landing"),
    manage: openAdmin,
    openContribution: setSubmissionMode
  };
  const administrationActions = {
    ...normCatalog.actions,
    selectNorm: setAdminId,
    openCreate: () => setShowCreate(true),
    openPublic: openNorm,
    deleteNorm
  };
  return /* @__PURE__ */ jsxs("main", { children: [
    /* @__PURE__ */ jsxs("header", { className: "topbar", children: [
      /* @__PURE__ */ jsxs("button", { className: "brand", onClick: () => actions.setView("landing"), children: [
        /* @__PURE__ */ jsx("img", { src: "/brand/sokol-symbol.png", alt: "" }),
        /* @__PURE__ */ jsxs("span", { children: [
          /* @__PURE__ */ jsx("strong", { children: "SOKOL" }),
          " spolurozhoduje"
        ] })
      ] }),
      /* @__PURE__ */ jsxs("nav", { "aria-label": "Hlavn\xED navigace", children: [
        /* @__PURE__ */ jsx("button", { className: view === "landing" ? "active" : "", onClick: () => actions.setView("landing"), children: "Normy" }),
        /* @__PURE__ */ jsx("button", { className: view === "detail" ? "active" : "", onClick: () => openNorm(selectedNorm?.id), children: "P\u0159ipom\xEDnkov\xE1n\xED" }),
        /* @__PURE__ */ jsx("button", { className: view === "admin" ? "active" : "", onClick: () => openAdmin(), children: "Administrace" }),
        canAccessUserAdministration(currentUser) && /* @__PURE__ */ jsx("button", { className: view === "users" ? "active" : "", onClick: () => actions.setView("users"), children: "U\u017Eivatel\xE9" })
      ] }),
      /* @__PURE__ */ jsx(
        UserMenu,
        {
          currentUser,
          onLogin: () => actions.openLogin(),
          onProfile: () => actions.setView("profile"),
          onLogout: actions.logout
        }
      )
    ] }),
    view === "landing" && /* @__PURE__ */ jsx(
      LandingPage,
      {
        norms: normCatalog.norms,
        filter: normCatalog.filter,
        onFilter: normCatalog.actions.setFilter,
        onOpen: openNorm
      }
    ),
    view === "detail" && /* @__PURE__ */ jsx(
      NormDetail,
      {
        norm: selectedNorm,
        currentUser,
        permissions: {
          canParticipate: normCatalog.permissions.canParticipate,
          canManage: normCatalog.permissions.canManageNorm(selectedNorm)
        },
        actions: detailActions
      }
    ),
    view === "admin" && /* @__PURE__ */ jsx(
      NormAdministration,
      {
        norms: normAdministration.norms,
        selectedNorm: adminNorm,
        currentUser,
        actions: administrationActions
      }
    ),
    view === "profile" && /* @__PURE__ */ jsx(
      MemberProfile,
      {
        user: currentUser,
        contributions: memberProfile.contributions,
        votes: memberProfile.votes
      }
    ),
    view === "users" && /* @__PURE__ */ jsx(
      UserAdministration,
      {
        currentUser,
        users: userAdministration.users,
        selectedUser: userAdministration.selectedUser,
        auditEvents: userAdministration.auditEvents,
        summary: userAdministration.summary,
        filters: userAdministration.filters,
        setupDeliveries: userAdministration.setupDeliveries,
        actions: userAdministration.actions
      }
    ),
    submissionMode && selectedNorm && /* @__PURE__ */ jsx("div", { className: "modalBackdrop", onMouseDown: () => setSubmissionMode(null), children: /* @__PURE__ */ jsxs("form", { className: "modal", onSubmit: submitContribution, onMouseDown: (event) => event.stopPropagation(), children: [
      /* @__PURE__ */ jsx("button", { type: "button", className: "modalClose", onClick: () => setSubmissionMode(null), children: "\xD7" }),
      /* @__PURE__ */ jsx("p", { className: "kicker", children: selectedNorm.number }),
      /* @__PURE__ */ jsx("h2", { children: submissionMode === "proposal" ? "Nov\xFD n\xE1vrh zm\u011Bny" : "Nov\xFD koment\xE1\u0159" }),
      /* @__PURE__ */ jsx("p", { children: "Jm\xE9no a jednota se bezpe\u010Dn\u011B p\u0159evezmou z p\u0159ihl\xE1\u0161en\xE9ho \xFA\u010Dtu." }),
      /* @__PURE__ */ jsxs("label", { children: [
        "\u010C\xE1st dokumentu",
        /* @__PURE__ */ jsx("input", { name: "section", placeholder: "nap\u0159. \xA7 4 odst. 2" })
      ] }),
      /* @__PURE__ */ jsxs("label", { children: [
        "N\xE1zev",
        /* @__PURE__ */ jsx("input", { name: "title", required: true, placeholder: "Stru\u010Dn\xE9 pojmenov\xE1n\xED podn\u011Btu" })
      ] }),
      /* @__PURE__ */ jsxs("label", { children: [
        submissionMode === "proposal" ? "Navrhovan\xE9 zn\u011Bn\xED a od\u016Fvodn\u011Bn\xED" : "Koment\xE1\u0159",
        /* @__PURE__ */ jsx("textarea", { name: "text", required: true })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "modalActions", children: [
        /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setSubmissionMode(null), children: "Zru\u0161it" }),
        /* @__PURE__ */ jsx("button", { className: "primaryButton", children: "Zve\u0159ejnit" })
      ] })
    ] }) }),
    showCreate && /* @__PURE__ */ jsx("div", { className: "modalBackdrop", onMouseDown: () => setShowCreate(false), children: /* @__PURE__ */ jsxs("form", { className: "modal wideModal", onSubmit: createNorm, onMouseDown: (event) => event.stopPropagation(), children: [
      /* @__PURE__ */ jsx("button", { type: "button", className: "modalClose", onClick: () => setShowCreate(false), children: "\xD7" }),
      /* @__PURE__ */ jsx("p", { className: "kicker", children: "Nov\xFD materi\xE1l" }),
      /* @__PURE__ */ jsx("h2", { children: "P\u0159edlo\u017Eit normu" }),
      /* @__PURE__ */ jsxs("div", { className: "formGrid", children: [
        /* @__PURE__ */ jsxs("label", { className: "wide", children: [
          "N\xE1zev normy",
          /* @__PURE__ */ jsx("input", { name: "title", required: true })
        ] }),
        /* @__PURE__ */ jsxs("label", { children: [
          "Druh dokumentu",
          /* @__PURE__ */ jsx("input", { name: "category", required: true, placeholder: "Sm\u011Brnice" })
        ] }),
        /* @__PURE__ */ jsxs("label", { children: [
          "Verze",
          /* @__PURE__ */ jsx("input", { name: "version", required: true, defaultValue: "1.0" })
        ] }),
        /* @__PURE__ */ jsxs("label", { children: [
          "P\u0159edkladatel",
          /* @__PURE__ */ jsx("input", { name: "submittedBy", required: true })
        ] }),
        /* @__PURE__ */ jsxs("label", { children: [
          "Odpov\xEDd\xE1 za normu",
          /* @__PURE__ */ jsx("input", { name: "responsible", required: true })
        ] }),
        /* @__PURE__ */ jsxs("label", { children: [
          "Status",
          /* @__PURE__ */ jsx("select", { name: "status", defaultValue: "Koncept", children: STATUS_OPTIONS.map((status) => /* @__PURE__ */ jsx("option", { children: status }, status)) })
        ] }),
        /* @__PURE__ */ jsxs("label", { children: [
          "Term\xEDn p\u0159ipom\xEDnek",
          /* @__PURE__ */ jsx("input", { name: "deadline", type: "date" })
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "wide", children: [
          "Kr\xE1tk\xE9 shrnut\xED",
          /* @__PURE__ */ jsx("textarea", { name: "summary", required: true })
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "wide", children: [
          "Pr\u016Fvodn\xED informace / d\u016Fvodov\xE1 zpr\xE1va",
          /* @__PURE__ */ jsx("textarea", { name: "reason", required: true })
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "fileField wide", children: [
          /* @__PURE__ */ jsx("span", { children: "P\u0159ilo\u017Eit dokument (max. 15 MB)" }),
          /* @__PURE__ */ jsx("input", { name: "file", type: "file", accept: ".pdf,.docx,.odt" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "modalActions", children: [
        /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setShowCreate(false), children: "Zru\u0161it" }),
        /* @__PURE__ */ jsx("button", { className: "primaryButton", children: "P\u0159edlo\u017Eit normu" })
      ] })
    ] }) }),
    authMode && services?.auth && /* @__PURE__ */ jsx(
      AuthDialog,
      {
        authMode,
        initialDelivery: authDelivery,
        authService: services.auth,
        onAuthenticated: actions.authenticated,
        onClose: actions.closeLogin
      }
    ),
    /* @__PURE__ */ jsx(Feedback, { feedback })
  ] });
}
export {
  Home as default
};
