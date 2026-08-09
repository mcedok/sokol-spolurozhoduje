"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserRepository } from "../data/browser-repository.js";
import * as fileRepository from "../data/file-repository.js";
import { USER_STATUS } from "../domain/constants.js";
import { createInitialState } from "../domain/demo-data.js";
import { canManageNorm, canManageUsers, canParticipate } from "../security/access-control.js";
import { createCryptoAdapter } from "../security/crypto-adapter.js";
import { createAuditService } from "../services/audit-service.js";
import { createAuthService } from "../services/auth-service.js";
import { createNormService } from "../services/norm-service.js";
import { createUserService } from "../services/user-service.js";

export const SESSION_STORAGE_KEY = "sokol-spolurozhoduje-session-id";

function createDefaultServices() {
  const repository = createBrowserRepository({ storage: window.localStorage });
  const audit = createAuditService(repository, Date.now);
  const auth = createAuthService({
    repository,
    audit,
    cryptoAdapter: createCryptoAdapter(window.crypto),
    now: Date.now,
  });
  const normService = createNormService({ repository, auth, audit, fileRepository, now: Date.now });
  const userService = createUserService({ repository, auth, audit, now: Date.now });
  return { repository, audit, auth, normService, userService };
}

export function useAppController({ createServices = createDefaultServices } = {}) {
  const [state, setState] = useState(() => createInitialState());
  const [session, setSession] = useState(null);
  const [view, setView] = useState("landing");
  const [authMode, setAuthMode] = useState(null);
  const [authDelivery, setAuthDelivery] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [normFilter, setNormFilter] = useState("Aktivní");
  const [userFilters, setUserFilters] = useState({ query: "", role: "", status: "" });
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [setupDeliveries, setSetupDeliveries] = useState([]);
  const [ready, setReady] = useState(false);
  const [services, setServices] = useState(null);
  const servicesRef = useRef(null);
  const feedbackTimerRef = useRef(null);

  const refresh = useCallback((preferredSessionId) => {
    const bundle = servicesRef.current;
    if (!bundle || typeof window === "undefined") return null;
    const snapshot = bundle.repository.read();
    setState(snapshot);
    const sessionId =
      preferredSessionId === undefined
        ? window.sessionStorage.getItem(SESSION_STORAGE_KEY)
        : preferredSessionId;
    if (!sessionId) {
      setSession(null);
      return snapshot;
    }
    try {
      setSession(bundle.auth.getSession(sessionId));
    } catch {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      setSession(null);
    }
    return snapshot;
  }, []);

  const flash = useCallback((message, kind = "info") => {
    setFeedback({ message, kind });
    if (typeof window === "undefined") return;
    if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(null), 3200);
  }, []);

  useEffect(() => {
    let active = true;
    const bundle = createServices();
    servicesRef.current = null;
    setServices(null);
    setReady(false);

    const initialSnapshot = bundle.repository.read?.();
    if (initialSnapshot?.recoveryRequired) {
      servicesRef.current = bundle;
      setServices(bundle);
      setState(initialSnapshot);
      setSession(null);
      setReady(true);
      return () => {
        active = false;
        if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
      };
    }

    void bundle.auth.ensureDemoCredentials().then(() => {
      if (!active) return;
      servicesRef.current = bundle;
      setServices(bundle);
      refresh();
      setReady(true);
    }).catch((error) => {
      if (!active) return;
      servicesRef.current = null;
      setServices(null);
      setReady(false);
      setAuthMode(null);
      flash(
        `${error?.message || "Modelové účty se nepodařilo připravit."} Načtěte stránku znovu.`,
        "error",
      );
    });

    return () => {
      active = false;
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    };
  }, [createServices, flash, refresh]);

  const resetDemoData = useCallback(async () => {
    const bundle = servicesRef.current;
    if (!bundle) return false;
    if (!window.confirm("Obnovení nahradí všechna lokální demo data ukázkovým stavem. Chcete pokračovat?")) {
      return false;
    }
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    bundle.repository.reset();
    await bundle.auth.ensureDemoCredentials();
    setAuthMode(null);
    setAuthDelivery(null);
    setView("landing");
    refresh(null);
    flash("Ukázková data byla obnovena.");
    return true;
  }, [flash, refresh]);

  const openLogin = useCallback((mode = "login") => {
    if (!servicesRef.current) return false;
    setAuthMode(mode);
    return true;
  }, []);

  const authenticated = useCallback((nextSession) => {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, nextSession.id);
    refresh(nextSession.id);
    setAuthMode(null);
    setAuthDelivery(null);
  }, [refresh]);

  const logout = useCallback(() => {
    const bundle = servicesRef.current;
    const sessionId = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (bundle && sessionId) bundle.auth.logout(sessionId);
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    refresh(null);
    setView("landing");
    setAuthDelivery(null);
    setSetupDeliveries([]);
    setSelectedUserId(null);
    flash("Byli jste odhlášeni.");
  }, [flash, refresh]);

  const mutate = useCallback(async (operation) => {
    const bundle = servicesRef.current;
    if (!bundle) {
      flash("Aplikace se ještě připravuje.", "error");
      return null;
    }
    try {
      const result = await operation(bundle);
      refresh();
      if (result?.message) flash(result.message);
      return result;
    } catch (error) {
      refresh();
      flash(error?.message || "Operaci se nepodařilo dokončit.", "error");
      return null;
    }
  }, [flash, refresh]);

  const requireLogin = useCallback((intent) => {
    const messages = {
      administration: "Administrace je dostupná po přihlášení správce.",
      comment: "Pro přidání komentáře se nejprve přihlaste.",
      proposal: "Pro přidání návrhu změny se nejprve přihlaste.",
      reply: "Pro přidání odpovědi se nejprve přihlaste.",
      "vote-need": "Pro hlasování se nejprve přihlaste.",
      "vote-submission": "Pro hlasování se nejprve přihlaste.",
    };
    openLogin();
    flash(messages[intent] || "Pro aktivní účast se nejprve přihlaste.");
    return null;
  }, [flash, openLogin]);

  const showParticipationUnavailable = useCallback(() => {
    flash("Účast je dostupná pouze aktivnímu členovi s ověřeným e-mailem.", "error");
    return null;
  }, [flash]);

  const runNormMutation = useCallback((operation) => {
    if (!session?.id) return requireLogin();
    return mutate((bundle) => operation(bundle.normService, session.id));
  }, [mutate, requireLogin, session?.id]);

  const updateNorm = useCallback((normId, patch) =>
    runNormMutation((normService, sessionId) => normService.update(sessionId, normId, patch)),
  [runNormMutation]);

  const replaceDocument = useCallback((norm, file) => {
    if (!file) return null;
    return runNormMutation((normService, sessionId) =>
      normService.replaceDocument(sessionId, norm.id, file),
    );
  }, [runNormMutation]);

  const deleteNorm = useCallback((norm) => {
    if (!window.confirm(`Opravdu smazat normu ${norm.number} – ${norm.title}?`)) return null;
    return runNormMutation((normService, sessionId) => normService.remove(sessionId, norm.id));
  }, [runNormMutation]);

  const createNorm = useCallback((input, file) =>
    runNormMutation((normService, sessionId) =>
      normService.create(sessionId, input, file),
    ),
  [runNormMutation]);

  const addContribution = useCallback((normId, input) =>
    runNormMutation((normService, sessionId) =>
      normService.addContribution(sessionId, normId, input),
    ),
  [runNormMutation]);

  const addReply = useCallback((normId, submissionId, text) =>
    runNormMutation((normService, sessionId) =>
      normService.reply(sessionId, normId, submissionId, text),
    ),
  [runNormMutation]);

  const voteSubmission = useCallback((normId, submissionId, direction) =>
    runNormMutation((normService, sessionId) =>
      normService.voteSubmission(sessionId, normId, submissionId, direction),
    ),
  [runNormMutation]);

  const voteNeed = useCallback((normId, value) =>
    runNormMutation((normService, sessionId) =>
      normService.voteNeed(sessionId, normId, value),
    ),
  [runNormMutation]);

  const resolveSubmission = useCallback((normId, submissionId, resolution) =>
    runNormMutation((normService, sessionId) =>
      normService.resolveSubmission(sessionId, normId, submissionId, resolution),
    ),
  [runNormMutation]);

  const changePassword = useCallback(async ({ currentPassword, newPassword }) => {
    if (!session?.id) return null;
    const result = await mutate((bundle) => bundle.auth.changePassword({
      sessionId: session.id,
      currentPassword,
      newPassword,
    }));
    if (!result) return null;
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    refresh(null);
    setView("landing");
    flash("Heslo bylo změněno. Přihlaste se znovu novým heslem.");
    return result;
  }, [flash, mutate, refresh, session?.id]);

  const downloadDocument = useCallback(async (norm) => {
    if (!norm.file?.id) {
      flash("K této normě zatím nebyl nahrán soubor.");
      return null;
    }
    try {
      const file = await fileRepository.readFile(norm.file.id);
      if (!file) throw new Error("Soubor nebyl nalezen");
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = norm.file.name;
      link.click();
      URL.revokeObjectURL(url);
      return file;
    } catch {
      flash("Soubor je uložen v jiném prohlížeči nebo byl odstraněn.", "error");
      return null;
    }
  }, [flash]);

  const enqueueSetupDelivery = useCallback((delivery) => {
    if (!delivery?.demoToken || delivery.kind !== "set_password") return;
    setSetupDeliveries((current) => [
      ...current.filter(
        (candidate) =>
          candidate.userId !== delivery.userId || candidate.kind !== delivery.kind,
      ),
      delivery,
    ]);
  }, []);

  const createUser = useCallback(async (input) => {
    if (!session?.id) return null;
    const result = await mutate((bundle) =>
      bundle.userService.createPrivilegedUser(session.id, input),
    );
    if (result?.userId) setSelectedUserId(result.userId);
    enqueueSetupDelivery(result);
    return result;
  }, [enqueueSetupDelivery, mutate, session?.id]);

  const setUserStatus = useCallback(async (userId, status) => {
    if (!session?.id) return null;
    const result = await mutate((bundle) =>
      bundle.userService.setUserStatus(session.id, userId, status),
    );
    enqueueSetupDelivery(result);
    return result;
  }, [enqueueSetupDelivery, mutate, session?.id]);

  const changeUserRole = useCallback(async (userId, role, transferNormsToUserId) => {
    if (!session?.id) return null;
    const result = await mutate((bundle) =>
      bundle.userService.changeUserRole(session.id, userId, role, transferNormsToUserId),
    );
    enqueueSetupDelivery(result);
    return result;
  }, [enqueueSetupDelivery, mutate, session?.id]);

  const openSetupDelivery = useCallback((delivery) => {
    if (!delivery?.demoToken) return;
    setAuthDelivery(delivery);
    setAuthMode("set-password");
  }, []);

  const updateUserFilters = useCallback((patch) => {
    setUserFilters((current) => ({ ...current, ...patch }));
  }, []);

  const currentUser = session?.user || null;
  const normCatalog = useMemo(() => {
    if (!services) {
      const closed = new Set(["Schváleno", "Neschváleno", "Archivováno"]);
      const active = new Set(["K připomínkování", "Vypořádání", "Ke schválení"]);
      return {
        filter: normFilter,
        norms: state.norms.filter((norm) =>
          normFilter === "Všechny" || (normFilter === "Uzavřené" ? closed.has(norm.status) : active.has(norm.status)),
        ),
        allNorms: state.norms,
      };
    }
    return {
      filter: normFilter,
      norms: services.normService.listPublicNorms(normFilter),
      allNorms: services.normService.listPublicNorms("Všechny"),
    };
  }, [normFilter, services, state.norms]);

  const normAdministration = useMemo(() => {
    if (!services || !session?.id) return { norms: [] };
    try {
      return { norms: services.normService.listManageable(session.id) };
    } catch {
      return { norms: [] };
    }
  }, [services, session?.id, state.norms]);

  const memberProfile = useMemo(() => {
    if (!currentUser) return { contributions: [], votes: [] };
    const contributions = state.norms.flatMap((norm) =>
      (norm.submissions || [])
        .filter((submission) => submission.authorUserId === currentUser.id)
        .map((submission) => ({ ...submission, normId: norm.id, normTitle: norm.title })),
    );
    const votes = Object.entries(state.votes || {}).flatMap(([key, value]) => {
      const [kind, userId, normId, submissionId] = key.split(":");
      if (userId !== currentUser.id) return [];
      const norm = state.norms.find((candidate) => candidate.id === normId);
      if (!norm) return [];
      if (kind === "need") {
        return [{ id: key, userId, normId, normTitle: norm.title, label: `Potřebnost normy: ${value === "yes" ? "ano" : "ne"}` }];
      }
      const submission = norm.submissions?.find((candidate) => candidate.id === submissionId);
      return [{
        id: key,
        userId,
        normId,
        normTitle: norm.title,
        label: `${Number(value) > 0 ? "Podpořen" : "Odmítnut"} podnět: ${submission?.title || "neznámý podnět"}`,
      }];
    });
    return { contributions, votes };
  }, [currentUser, state.norms, state.votes]);
  const userAdministration = useMemo(() => {
    const empty = {
      users: [],
      selectedUser: null,
      auditEvents: [],
      summary: { active: 0, invited: 0, blocked: 0 },
      transferCandidates: [],
    };
    if (!services || !session?.id || !canManageUsers(currentUser)) return empty;
    try {
      const allUsers = services.userService.listUsers(session.id);
      const users = services.userService.listUsers(session.id, userFilters);
      const selected = selectedUserId
        ? services.userService.getUser(session.id, selectedUserId)
        : null;
      const selectedUser = selected
        ? {
          ...selected,
          ownedNormCount: state.norms.filter((norm) => norm.ownerAdminId === selected.id).length,
        }
        : null;
      return {
        users,
        selectedUser,
        auditEvents: selectedUser
          ? services.audit.listForTarget("user", selectedUser.id).slice().reverse()
          : [],
        summary: {
          active: allUsers.filter((user) => user.status === USER_STATUS.ACTIVE).length,
          invited: allUsers.filter((user) => user.status === USER_STATUS.INVITED).length,
          blocked: allUsers.filter((user) => user.status === USER_STATUS.BLOCKED).length,
        },
        transferCandidates: allUsers.filter(
          (user) =>
            user.status === USER_STATUS.ACTIVE &&
            ["admin", "superadmin"].includes(user.role),
        ),
      };
    } catch {
      return empty;
    }
  }, [currentUser, services, session?.id, state, userFilters, selectedUserId]);

  const userAdministrationActions = useMemo(() => ({
    setFilters: updateUserFilters,
    selectUser: setSelectedUserId,
    createUser,
    setUserStatus,
    changeUserRole,
    openSetupDelivery,
    transferCandidates: userAdministration.transferCandidates,
  }), [
    changeUserRole,
    createUser,
    openSetupDelivery,
    setUserStatus,
    updateUserFilters,
    userAdministration.transferCandidates,
  ]);

  const actions = useMemo(() => ({
    ready,
    setView,
    openLogin,
    closeLogin: () => {
      setAuthMode(null);
      setAuthDelivery(null);
    },
    authenticated,
    logout,
    refresh,
    mutate,
    requireLogin,
    showParticipationUnavailable,
    flash,
    clearFeedback: () => setFeedback(null),
    resetDemoData,
  }), [authenticated, flash, logout, mutate, openLogin, ready, refresh, requireLogin, resetDemoData, showParticipationUnavailable]);

  const normActions = useMemo(() => ({
    setFilter: setNormFilter,
    requireLogin,
    showParticipationUnavailable,
    downloadDocument,
    updateNorm,
    replaceDocument,
    deleteNorm,
    createNorm,
    addContribution,
    addReply,
    voteSubmission,
    voteNeed,
    resolveSubmission,
  }), [
    addContribution,
    addReply,
    createNorm,
    deleteNorm,
    downloadDocument,
    replaceDocument,
    requireLogin,
    resolveSubmission,
    showParticipationUnavailable,
    updateNorm,
    voteNeed,
    voteSubmission,
  ]);

  return {
    state,
    session,
    currentUser,
    view,
    actions,
    feedback,
    authMode,
    authDelivery,
    services,
    normCatalog: {
      ...normCatalog,
      actions: normActions,
      permissions: {
        canParticipate: canParticipate(currentUser),
        canManageNorm: (norm) => canManageNorm(currentUser, norm),
        needVote: (norm) => currentUser
          ? state.votes?.[`need:${currentUser.id}:${norm?.id}`] || null
          : null,
        submissionVote: (norm, submissionId) => currentUser
          ? Number(state.votes?.[`submission:${currentUser.id}:${norm?.id}:${submissionId}`] || 0)
          : 0,
      },
    },
    normAdministration,
    memberProfile: {
      ...memberProfile,
      actions: { changePassword },
    },
    userAdministration: {
      ...userAdministration,
      filters: userFilters,
      setupDeliveries,
      actions: userAdministrationActions,
    },
  };
}
