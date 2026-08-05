"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserRepository } from "../data/browser-repository.js";
import * as fileRepository from "../data/file-repository.js";
import { USER_STATUS } from "../domain/constants.js";
import { createInitialState } from "../domain/demo-data.js";
import { canManageUsers } from "../security/access-control.js";
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

  const enqueueSetupDelivery = useCallback((delivery) => {
    if (!delivery?.demoToken || delivery.kind !== "set_password") return;
    setSetupDeliveries((current) => [
      ...current.filter((candidate) => candidate.challengeId !== delivery.challengeId),
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
    return mutate((bundle) => bundle.userService.setUserStatus(session.id, userId, status));
  }, [mutate, session?.id]);

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
    flash,
    clearFeedback: () => setFeedback(null),
  }), [authenticated, flash, logout, mutate, openLogin, ready, refresh]);

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
    userAdministration: {
      ...userAdministration,
      filters: userFilters,
      setupDeliveries,
      actions: userAdministrationActions,
    },
  };
}
