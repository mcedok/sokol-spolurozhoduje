import { createElement as h, useEffect, useRef, useState } from "react";
import { useDialogFocusTrap } from "../../hooks/use-dialog-focus-trap.js";
import { DemoInbox } from "./DemoInbox.js";

const INITIAL_STEP = {
  login: "access-choice",
  register: "register",
  "forgot-password": "forgot-password",
};

function DemoCredentials({ visible }) {
  if (!visible) return null;
  return h(
    "aside",
    { className: "demoCredentials", "aria-labelledby": "demo-credentials-title" },
    h("p", { className: "kicker" }, "Vyzkoušet demoverzi"),
    h("h3", { id: "demo-credentials-title" }, "Modelové účty"),
    h("strong", { className: "demoWarning" }, "Pouze neprodukční testovací údaje"),
    h("ul", null,
      h("li", null, "superadmin@sokol.demo / SuperSokol!2026"),
      h("li", null, "administrator@sokol.demo / AdminSokol!2026"),
      h("li", null, "clen@sokol.demo / 260814"),
    ),
  );
}

function Field({ label, inputRef, ...props }) {
  return h("label", null, label, h("input", { ref: inputRef, ...props }));
}

export function AuthDialog({ authMode, initialDelivery, onClose, onAuthenticated, authService }) {
  const [step, setStep] = useState(initialDelivery ? "set-password" : INITIAL_STEP[authMode] || "identify");
  const [email, setEmail] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState(initialDelivery?.demoToken || "");
  const [loginAttemptId, setLoginAttemptId] = useState("");
  const [activeDelivery, setActiveDelivery] = useState(initialDelivery || null);
  const [deliveries, setDeliveries] = useState(initialDelivery ? [initialDelivery] : []);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const firstFieldRef = useRef(null);
  const dialogRef = useDialogFocusTrap({ onClose });

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [step]);

  function transition(nextStep) {
    setError("");
    setNotice("");
    setStep(nextStep);
  }

  function addDelivery(delivery) {
    if (!delivery?.demoCode && !delivery?.demoToken) return;
    setDeliveries((current) => [...current, delivery]);
  }

  function report(errorValue) {
    setError(errorValue?.message || "Přihlášení se nepodařilo.");
  }

  function reportPasswordLogin(errorValue) {
    if (["ACCOUNT_BLOCKED", "INVALID_CREDENTIALS"].includes(errorValue?.code)) {
      setError("E-mail nebo heslo nejsou platné nebo účet není dostupný.");
      return;
    }
    report(errorValue);
  }

  async function identify(event) {
    event.preventDefault();
    setError("");
    try {
      const result = await authService.identify(email);
      if (result.kind === "password") return transition("password");
      if (result.kind === "register") return transition("register");
      if (result.kind === "method-choice") return transition("method-choice");

      const delivery = await authService.requestMemberCode(email);
      if (!delivery.challengeId) throw new Error("Přihlášení se nepodařilo. Zkontrolujte stav účtu.");
      setChallengeId(delivery.challengeId);
      addDelivery(delivery);
      transition("member-code");
    } catch (errorValue) {
      report(errorValue);
    }
  }

  async function requestCodeForEmail() {
    setError("");
    try {
      const delivery = await authService.requestMemberCode(email);
      if (!delivery.challengeId) throw new Error("Přihlášení se nepodařilo.");
      setChallengeId(delivery.challengeId);
      addDelivery(delivery);
      transition("member-code");
    } catch (errorValue) {
      report(errorValue);
    }
  }

  async function register(event) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const delivery = await authService.registerMember({
        firstName: data.get("firstName"),
        lastName: data.get("lastName"),
        email: data.get("email"),
        sokolUnit: data.get("sokolUnit"),
        membershipId: data.get("membershipId"),
      });
      setEmail(String(data.get("email")));
      setChallengeId(delivery.challengeId);
      addDelivery(delivery);
      transition("member-code");
    } catch (errorValue) {
      report(errorValue);
    }
  }

  async function verifyCode(event) {
    event.preventDefault();
    setError("");
    try {
      const session = await authService.verifyMemberCode({ challengeId, code });
      setStep("done");
      onAuthenticated(session);
      onClose();
    } catch (errorValue) {
      report(errorValue);
    }
  }

  async function login(event) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const session = await authService.loginWithPassword({ email, password: data.get("password") });
      if (session.kind === "mfa_required") {
        setLoginAttemptId(session.loginAttemptId);
        return transition("admin-mfa");
      }
      setStep("done");
      onAuthenticated(session);
      onClose();
    } catch (errorValue) {
      reportPasswordLogin(errorValue);
    }
  }

  async function verifyAdminMfa(event) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const session = await authService.verifyAdminMfa({
        loginAttemptId,
        token: data.get("token"),
      });
      setStep("done");
      onAuthenticated(session);
      onClose();
    } catch (errorValue) {
      report(errorValue);
    }
  }

  async function requestReset(event) {
    event.preventDefault();
    setError("");
    try {
      const delivery = await authService.requestPasswordReset(email);
      addDelivery(delivery);
      setNotice("Pokud účet existuje, odkaz pro obnovu byl vytvořen.");
    } catch (errorValue) {
      report(errorValue);
    }
  }

  async function setPassword(event) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const operation = activeDelivery?.kind === "set_password"
        ? authService.completePasswordSetup
        : authService.completePasswordReset;
      await operation({ token, password: data.get("newPassword") });
      setNotice("Nové heslo je nastavené. Nyní se můžete přihlásit.");
      setStep(activeDelivery?.kind === "set_password" ? "identify" : "password");
    } catch (errorValue) {
      report(errorValue);
    }
  }

  function useCode(delivery) {
    setChallengeId(delivery.challengeId);
    setCode(delivery.demoCode);
    transition("member-code");
  }

  function openLink(delivery) {
    setToken(delivery.demoToken);
    setActiveDelivery(delivery);
    transition("set-password");
  }

  let form;
  if (step === "access-choice") {
    form = h("section", null,
      h("p", null, "Vyberte, zda už účet máte, nebo se registrujete poprvé."),
      h("div", { className: "modalActions stackedActions" },
        h("button", {
          type: "button",
          className: "primaryButton",
          onClick: () => transition("identify"),
        }, "Jsem registrovaný uživatel"),
        h("button", { type: "button", onClick: () => transition("register") }, "Jsem nový uživatel"),
      ),
    );
  } else if (step === "identify") {
    form = h("form", { onSubmit: identify },
      h("p", null, "Zadejte e-mail. Podle typu účtu nabídneme bezpečný způsob přihlášení."),
      notice && h("p", { className: "authNotice", role: "status" }, notice),
      h(Field, { key: "identify-email", label: "E-mail", name: "email", type: "email", required: true, value: email, onChange: (event) => setEmail(event.target.value), inputRef: firstFieldRef }),
      h("div", { className: "modalActions" }, h("button", { className: "primaryButton" }, "Pokračovat")),
    );
  } else if (step === "method-choice") {
    form = h("section", null,
      h("p", null, "Vyberte způsob přihlášení. Výsledek neprozradí, zda účet existuje."),
      h("div", { className: "modalActions stackedActions" },
        h("button", { type: "button", className: "primaryButton", onClick: requestCodeForEmail }, "Poslat kód e-mailem"),
        h("button", { type: "button", onClick: () => transition("password") }, "Heslo správce"),
        h("button", { type: "button", onClick: () => transition("register") }, "Nová registrace člena"),
      ),
    );
  } else if (step === "register") {
    form = h("form", { onSubmit: register },
      h("p", null, "Vytvořte členský účet a ověřte e-mail jednorázovým kódem."),
      h("div", { className: "formGrid" },
        h(Field, { key: "register-first-name", label: "Jméno", name: "firstName", required: true, inputRef: firstFieldRef }),
        h(Field, { label: "Příjmení", name: "lastName", required: true }),
        h(Field, { label: "E-mail", name: "email", type: "email", required: true, value: email, onChange: (event) => setEmail(event.target.value) }),
        h(Field, { label: "Tělocvičná jednota", name: "sokolUnit", required: true }),
        h(Field, { label: "Členské číslo", name: "membershipId", required: true }),
      ),
      h("div", { className: "modalActions" },
        h("button", { type: "button", onClick: () => transition("access-choice") }, "Zpět"),
        h("button", { className: "primaryButton" }, "Dokončit registraci"),
      ),
    );
  } else if (step === "member-code") {
    form = h("form", { onSubmit: verifyCode },
      h("p", null, authService.backend === "server"
        ? "Zadejte šestimístný kód doručený na váš e-mail."
        : "Zadejte šestimístný kód ze simulované schránky."),
      h(Field, { key: "member-code", label: "Ověřovací kód", name: "code", inputMode: "numeric", pattern: "[0-9]{6}", required: true, value: code, onChange: (event) => setCode(event.target.value), inputRef: firstFieldRef }),
      h("div", { className: "modalActions" }, h("button", { className: "primaryButton" }, "Ověřit kód")),
    );
  } else if (step === "password") {
    form = h("form", { onSubmit: login },
      notice && h("p", { className: "authNotice", role: "status" }, notice),
      h(Field, { key: "login-password", label: "Heslo", name: "password", type: "password", required: true, inputRef: firstFieldRef }),
      h("div", { className: "passwordActions" },
        h("button", { type: "button", className: "linkButton", onClick: () => transition("forgot-password") }, "Zapomenuté heslo"),
        h("button", { className: "primaryButton" }, "Přihlásit"),
      ),
    );
  } else if (step === "admin-mfa") {
    form = h("form", { onSubmit: verifyAdminMfa },
      h("p", null, "Zadejte šestimístný kód z autentizační aplikace."),
      h(Field, { key: "admin-mfa", label: "Ověřovací kód", name: "token", inputMode: "numeric", pattern: "[0-9]{6}", required: true, inputRef: firstFieldRef }),
      h("div", { className: "modalActions" }, h("button", { className: "primaryButton" }, "Dokončit přihlášení")),
    );
  } else if (step === "forgot-password") {
    form = h("form", { onSubmit: requestReset },
      h("p", null, "Odkaz se vytvoří pouze pro způsobilý správcovský účet. Výsledek vždy potvrzujeme neutrálně."),
      h(Field, { key: "reset-email", label: "E-mail", name: "email", type: "email", required: true, value: email, onChange: (event) => setEmail(event.target.value), inputRef: firstFieldRef }),
      notice && h("p", { className: "authNotice", role: "status" }, notice),
      h("div", { className: "modalActions" },
        h("button", { type: "button", onClick: () => transition("password") }, "Zpět"),
        h("button", { className: "primaryButton" }, "Poslat odkaz pro obnovu"),
      ),
    );
  } else if (step === "set-password") {
    form = h("form", { onSubmit: setPassword },
      h("p", null, "Heslo musí mít alespoň 10 znaků, malé a velké písmeno, číslici a speciální znak."),
      h(Field, { key: "new-password", label: "Nové heslo", name: "newPassword", type: "password", required: true, inputRef: firstFieldRef }),
      h("div", { className: "modalActions" }, h("button", { className: "primaryButton" }, "Nastavit nové heslo")),
    );
  } else {
    form = h("p", { role: "status" }, "Přihlášení bylo dokončeno.");
  }

  return h(
    "div",
    { className: "modalBackdrop authBackdrop", onMouseDown: onClose },
    h(
      "section",
      {
        className: "modal authDialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "auth-title",
        "data-testid": "auth-dialog",
        "data-auth-step": step,
        ref: dialogRef,
        onMouseDown: (event) => event.stopPropagation(),
      },
      h("button", { type: "button", className: "modalClose", "aria-label": "Zavřít", onClick: onClose }, "×"),
      h("p", { className: "kicker" }, "Členský přístup"),
      h("h2", { id: "auth-title" }, step === "register" ? "Registrace" : "Přihlášení"),
      error && h("div", { className: "authError", role: "alert" }, error),
      authService.backend !== "server" && h(
        "p",
        { className: "demoBoundary", role: "note" },
        "Lokální demoverze: data jsou uložena pouze v tomto profilu prohlížeče a nejsou sdílena mezi zařízeními. Nejde o produkčně bezpečné přihlášení.",
      ),
      form,
      h(DemoInbox, { deliveries, onUseCode: useCode, onOpenLink: openLink }),
      h(DemoCredentials, { visible: authService.backend !== "server" }),
    ),
  );
}
