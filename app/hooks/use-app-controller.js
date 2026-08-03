"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserRepository } from "../data/browser-repository.js";
import * as fileRepository from "../data/file-repository.js";
import { createInitialState } from "../domain/demo-data.js";
import { createCryptoAdapter } from "../security/crypto-adapter.js";
import { createAuditService } from "../services/audit-service.js";
import { createAuthService } from "../services/auth-service.js";
import { createNormService } from "../services/norm-service.js";
import { createUserService } from "../services/user-service.js";

export const SESSION_STORAGE_KEY = "sokol-spolurozhoduje-session-id";

export function useAppController() {
  const [state, setState] = useState(() => createInitialState());
  const [session, setSession] = useState(null);
  const [view, setView] = useState("landing");
  const [authMode, setAuthMode] = useState(null);
  const [feedback, setFeedback] = useState(null);
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
    const bundle = { repository, audit, auth, normService, userService };
    servicesRef.current = bundle;

    void auth.ensureDemoCredentials().then(() => {
      if (!active) return;
      setServices(bundle);
      refresh();
      setReady(true);
    }).catch((error) => {
      if (!active) return;
      setServices(bundle);
      refresh();
      flash(error?.message || "Modelové účty se nepodařilo připravit.", "error");
      setReady(true);
    });

    return () => {
      active = false;
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    };
  }, [flash, refresh]);

  const authenticated = useCallback((nextSession) => {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, nextSession.id);
    refresh(nextSession.id);
    setAuthMode(null);
  }, [refresh]);

  const logout = useCallback(() => {
    const bundle = servicesRef.current;
    const sessionId = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (bundle && sessionId) bundle.auth.logout(sessionId);
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    refresh(null);
    setView("landing");
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

  const actions = useMemo(() => ({
    ready,
    setView,
    openLogin: (mode = "login") => setAuthMode(mode),
    closeLogin: () => setAuthMode(null),
    authenticated,
    logout,
    refresh,
    mutate,
    flash,
    clearFeedback: () => setFeedback(null),
  }), [authenticated, flash, logout, mutate, ready, refresh]);

  return {
    state,
    session,
    currentUser: session?.user || null,
    view,
    actions,
    feedback,
    authMode,
    services,
  };
}
