# User Access Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doplnit do demoverze Sokol spolurozhoduje tři pevné role, heslové přihlášení správců, bezheslové přihlášení členů, správu uživatelů a důslednou kontrolu vlastnictví norem.

**Architecture:** Stávající klientská aplikace zůstane lokální demoverzí, ale stav a oprávnění se přesunou z monolitické stránky do samostatných služeb nad verzovaným úložištěm. React komponenty budou volat jediný aplikační řadič; každá změnová služba znovu ověří relaci, roli, stav účtu a případně `ownerAdminId`, takže skrytí tlačítka nebude jedinou ochranou.

**Tech Stack:** Next.js 16.2.11, React 19.2.8, vinext, Vite 8, Web Crypto API, localStorage, IndexedDB, Vitest, jsdom a Testing Library.

## Global Constraints

- Role jsou pouze `member`, `admin` a `superadmin`; individuální výjimky nejsou podporovány.
- Člen se registruje s povinnými poli jméno, příjmení, sokolská jednota, členské ID a jedinečný e-mail.
- Člen se registruje a přihlašuje jednorázovým šestimístným kódem; nemá heslo.
- Administrátor a superadministrátor se přihlašují e-mailem a heslem o nejméně 10 znacích obsahujícím malé písmeno, velké písmeno, číslici a speciální znak.
- Členský kód platí 10 minut, je jednorázový a dovoluje nejvýše pět chybných pokusů.
- Odkaz pro první nastavení nebo obnovu správcovského hesla platí 30 minut a je jednorázový.
- Relace platí osm hodin a blokace účtu ji okamžitě ruší.
- Administrátor spravuje pouze normy s vlastním `ownerAdminId`; superadministrátor spravuje všechny normy.
- Veřejnost čte seznam i detail publikovaných norem; aktivní účast vyžaduje přihlášený účet s ověřeným e-mailem.
- `visibilityMode` se uloží s hodnotou `public-detail`; režim `title-only` nebude v této etapě přepínatelný.
- Demo data zůstávají pouze v jednom profilu prohlížeče a tato hranice musí být viditelně komunikována.
- Zachovat číslování `SOKOL-RRRR-NNN`, limit souboru 15 MB, české texty a současný střídmý vizuální styl Sokola.

---

## File Map

- `app/page.js` — tenká kompozice obrazovek a aplikačního řadiče.
- `app/domain/constants.js` — role, stavy účtů, typy výzev a časové limity.
- `app/domain/demo-data.js` — modelové účty, výchozí normy a veřejné demo přihlašovací údaje.
- `app/data/browser-repository.js` — verzované načítání, migrace a atomické ukládání aplikačního stavu.
- `app/data/file-repository.js` — stávající operace IndexedDB se soubory.
- `app/security/crypto-adapter.js` — generování kódů/tokenů a odvození/ověření hesla přes Web Crypto.
- `app/security/access-control.js` — čisté autorizační predikáty a chyby.
- `app/services/audit-service.js` — append-only audit bez tajných údajů.
- `app/services/auth-service.js` — registrace, obě přihlašovací metody, výzvy, hesla a relace.
- `app/services/user-service.js` — seznam, filtry, zakládání správců, role a blokace.
- `app/services/norm-service.js` — všechny změny norem, příspěvků a hlasů s autorizací.
- `app/hooks/use-app-controller.js` — propojení služeb s React stavem a navigací.
- `app/components/auth/AuthDialog.js` — registrace a přihlášení podle typu účtu.
- `app/components/auth/DemoInbox.js` — simulované kódy a odkazy.
- `app/components/auth/UserMenu.js` — stav relace, profil a odhlášení.
- `app/components/member/MemberProfile.js` — profil a vlastní příspěvky člena.
- `app/components/admin/UserAdministration.js` — tabulka, filtry a detail uživatele.
- `app/components/admin/NormAdministration.js` — správa vlastních nebo všech norem podle role.
- `app/components/public/LandingPage.js` — veřejný seznam norem.
- `app/components/public/NormDetail.js` — veřejný detail a přihlášená účast.
- `app/components/shared/Feedback.js` — toast, prázdný stav a autorizační hlášky.
- `app/globals.css` — styly nových obrazovek a mobilních stavů.
- `test/setup.js` — jsdom a reset úložiště mezi testy.
- `test/fakes.js` — deterministický čas, crypto adaptér a továrny testovacích stavů.
- `test/*.test.js` — jednotkové a komponentové testy podle úloh níže.
- `vitest.config.js` — testovací prostředí a React transformace.
- `package.json`, `pnpm-lock.yaml` — testovací příkazy a závislosti.
- `README.md`, `docs/ARCHITECTURE.md` — demo účty, bezpečnostní hranice a produkční cesta.

---

### Task 1: Verzované úložiště a testovací základ

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `vitest.config.js`
- Create: `test/setup.js`
- Create: `test/fakes.js`
- Create: `test/browser-repository.test.js`
- Create: `app/domain/constants.js`
- Create: `app/domain/demo-data.js`
- Create: `app/data/browser-repository.js`
- Create: `app/data/file-repository.js`
- Modify: `app/page.js`

**Interfaces:**
- Produces: `createBrowserRepository({ storage, now }): { read(), update(mutator), reset() }`.
- Produces: `createInitialState(): AppState` se `schemaVersion: 3`, `users`, `challenges`, `sessions`, `auditEvents`, `norms` a `votes`.
- Produces: `ROLE`, `USER_STATUS`, `CHALLENGE_TYPE`, `LIMITS` a `DEMO_CREDENTIALS`.
- Produces: `storeFile(id, file)`, `readFile(id)` a `removeFile(id)` přesunuté beze změny chování.

- [ ] **Step 1: Přidat testovací příkazy a závislosti**

Do `package.json` přidat skripty:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Přidat vývojové závislosti `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event` a `@testing-library/jest-dom`, poté spustit:

```bash
pnpm install
```

- [ ] **Step 2: Zapsat konfiguraci a první neúspěšný migrační test**

`vitest.config.js`:

```js
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./test/setup.js"] },
});
```

V `test/browser-repository.test.js` ověřit, že stav v2 získá `schemaVersion: 3`, každá norma `visibilityMode: "public-detail"` a chybějící `ownerAdminId` modelového administrátora:

```js
it("migrates v2 norms to the access-control schema", () => {
  localStorage.setItem("sokol-spolurozhoduje-pilot-v2", JSON.stringify([{ id: "n1" }]));
  const state = createBrowserRepository({ storage: localStorage, now: () => 1 }).read();
  expect(state.schemaVersion).toBe(3);
  expect(state.norms[0]).toMatchObject({
    id: "n1",
    ownerAdminId: "user-admin-demo",
    visibilityMode: "public-detail",
  });
});
```

- [ ] **Step 3: Spustit test a potvrdit očekávané selhání**

Run: `pnpm test -- test/browser-repository.test.js`  
Expected: FAIL, protože `createBrowserRepository` zatím neexistuje.

- [ ] **Step 4: Implementovat konstanty, demo data a migraci**

Definovat přesně:

```js
export const ROLE = { MEMBER: "member", ADMIN: "admin", SUPERADMIN: "superadmin" };
export const USER_STATUS = {
  INVITED: "invited",
  PENDING: "pending_verification",
  ACTIVE: "active",
  BLOCKED: "blocked",
};
export const CHALLENGE_TYPE = {
  MEMBER_CODE: "member_code",
  SET_PASSWORD: "set_password",
  RESET_PASSWORD: "reset_password",
};
export const LIMITS = {
  memberCodeMs: 10 * 60 * 1000,
  passwordLinkMs: 30 * 60 * 1000,
  sessionMs: 8 * 60 * 60 * 1000,
  maxCodeAttempts: 5,
};
```

`createBrowserRepository.update` musí načíst aktuální stav, vytvořit kopii přes `structuredClone`, aplikovat mutátor, uložit JSON a vrátit nový stav. Nečitelný JSON nesmí automaticky smazat; metoda `read()` vrátí `createInitialState()` s příznakem `recoveryRequired: true`, aby UI mohlo vyžádat potvrzení resetu.

- [ ] **Step 5: Přesunout IndexedDB operace a napojit import v `page.js`**

Přesunout `openFilesDb`, `storeFile`, `readFile` a `removeFile` do `app/data/file-repository.js`; jejich veřejné signatury zachovat. V `page.js` odstranit původní definice a importovat nové funkce.

- [ ] **Step 6: Ověřit testy a sestavení**

Run: `pnpm test -- test/browser-repository.test.js && pnpm build`  
Expected: PASS a úspěšné vytvoření `dist`.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.js test/setup.js test/fakes.js test/browser-repository.test.js app/domain app/data app/page.js
git commit -m "test: add versioned browser data foundation"
```

---

### Task 2: Autorizační pravidla a audit

**Files:**
- Create: `test/access-control.test.js`
- Create: `test/audit-service.test.js`
- Create: `app/security/access-control.js`
- Create: `app/services/audit-service.js`

**Interfaces:**
- Consumes: `ROLE`, `USER_STATUS` z Task 1.
- Produces: `canParticipate(user)`, `canManageUsers(user)`, `canCreateNorm(user)`, `canManageNorm(user, norm)` a `assertAuthorized(condition, code)`.
- Produces: `createAuditService(repository, now)` s metodami `record(event)` a `listForTarget(targetType, targetId)`.

- [ ] **Step 1: Zapsat neúspěšné testy matice oprávnění**

Test musí pokrýt veřejnost, aktivního i blokovaného člena, vlastní a cizí normu administrátora a libovolnou normu superadministrátora:

```js
expect(canParticipate(activeMember)).toBe(true);
expect(canParticipate(blockedMember)).toBe(false);
expect(canManageNorm(adminA, { ownerAdminId: adminA.id })).toBe(true);
expect(canManageNorm(adminA, { ownerAdminId: adminB.id })).toBe(false);
expect(canManageNorm(superadmin, { ownerAdminId: adminB.id })).toBe(true);
expect(canManageUsers(adminA)).toBe(false);
expect(canManageUsers(superadmin)).toBe(true);
```

- [ ] **Step 2: Spustit test a potvrdit selhání**

Run: `pnpm test -- test/access-control.test.js`  
Expected: FAIL na chybějícím modulu.

- [ ] **Step 3: Implementovat čisté autorizační predikáty**

`canParticipate` vyžaduje `status === "active"` a neprázdné `emailVerifiedAt`. `canManageNorm` vrací `true` pouze aktivnímu superadministrátorovi nebo aktivnímu administrátorovi shodnému s `norm.ownerAdminId`. `assertAuthorized(false, code)` vyhodí `AuthorizationError` s českou uživatelskou zprávou mapovanou podle kódu.

- [ ] **Step 4: Zapsat a implementovat auditní test**

Ověřit, že `record({ actorUserId, action, targetType, targetId, metadata })` přidá událost, ale odstraní klíče `password`, `code`, `token`, `passwordHash` a `passwordSalt` i z vnořených metadat.

- [ ] **Step 5: Ověřit oba testy**

Run: `pnpm test -- test/access-control.test.js test/audit-service.test.js`  
Expected: všechny testy PASS.

- [ ] **Step 6: Commit**

```bash
git add app/security/access-control.js app/services/audit-service.js test/access-control.test.js test/audit-service.test.js
git commit -m "feat: centralize role authorization and audit"
```

---

### Task 3: Crypto adaptér, výzvy, hesla a relace

**Files:**
- Create: `test/crypto-adapter.test.js`
- Create: `test/auth-service.test.js`
- Create: `app/security/crypto-adapter.js`
- Create: `app/services/auth-service.js`
- Modify: `app/domain/demo-data.js`
- Modify: `test/fakes.js`

**Interfaces:**
- Consumes: repository, audit service, `CHALLENGE_TYPE`, `LIMITS`, `USER_STATUS`.
- Produces: `createCryptoAdapter(crypto)` s `randomDigits(6)`, `randomToken()`, `hashSecret(secret, salt?)` a `verifySecret(secret, salt, expectedHash)`.
- Produces: `createAuthService({ repository, audit, cryptoAdapter, now })`.
- Auth metody: `registerMember(profile)`, `requestMemberCode(email)`, `verifyMemberCode({ challengeId, code })`, `loginWithPassword({ email, password })`, `createPasswordSetup(actorSessionId, userId)`, `completePasswordSetup({ token, password })`, `requestPasswordReset(email)`, `completePasswordReset({ token, password })`, `changePassword({ sessionId, currentPassword, newPassword })`, `getSession(sessionId)`, `logout(sessionId)` a `revokeUserSessions(userId)`.

- [ ] **Step 1: Zapsat neúspěšné testy crypto adaptéru**

Testy ověří, že stejný secret a sůl projde, jiné heslo neprojde, generovaný členský kód má šest číslic a token má nejméně 32 náhodných bajtů před kódováním.

- [ ] **Step 2: Implementovat Web Crypto adaptér**

Použít PBKDF2 se SHA-256, samostatnou 16bajtovou solí a 210 000 iteracemi. Výstup ukládat jako Base64. Porovnání výsledných bytů provést konstantním průchodem bez předčasného návratu.

- [ ] **Step 3: Zapsat neúspěšné testy členského toku**

Testy musí ověřit:

```js
const delivery = await auth.registerMember(memberProfile);
expect(delivery.kind).toBe("member_code");
await expect(auth.verifyMemberCode({ challengeId: delivery.challengeId, code: "000000" }))
  .rejects.toMatchObject({ code: "INVALID_CODE" });
const session = await auth.verifyMemberCode({ challengeId: delivery.challengeId, code: delivery.demoCode });
expect(session.expiresAt - clock.now()).toBe(8 * 60 * 60 * 1000);
```

Doplnit expiraci po 10 minutách, jednorázovost a uzamčení po pátém chybném pokusu.

- [ ] **Step 4: Zapsat neúspěšné testy správcovského toku**

Ověřit modelová hesla `SuperSokol!2026` a `AdminSokol!2026`, odmítnutí slabého hesla, 30minutovou expiraci odkazu, jednorázovou obnovu, zneplatnění starého hesla a neutrální výsledek resetu pro neznámý e-mail.

- [ ] **Step 5: Implementovat `auth-service.js` minimálně pro všechny testované toky**

Každá výzva uloží pouze hash kódu nebo tokenu. Návratová hodnota smí obsahovat `demoCode` nebo `demoToken` pouze proto, aby ji komponenta `DemoInbox` zobrazila; audit tyto hodnoty nepřevezme. `getSession` musí odmítnout expirovanou, zrušenou nebo blokovanému účtu patřící relaci.

- [ ] **Step 6: Inicializovat modelová hesla při prvním načtení**

Přidat `auth.ensureDemoCredentials()`, které pouze účtům bez `passwordHash` odvodí hash z `DEMO_CREDENTIALS`; existující uživatelem změněné heslo nikdy nepřepíše.

- [ ] **Step 7: Ověřit testy**

Run: `pnpm test -- test/crypto-adapter.test.js test/auth-service.test.js`  
Expected: všechny scénáře PASS.

- [ ] **Step 8: Commit**

```bash
git add app/security/crypto-adapter.js app/services/auth-service.js app/domain/demo-data.js test/fakes.js test/crypto-adapter.test.js test/auth-service.test.js
git commit -m "feat: add password and one-time-code authentication"
```

---

### Task 4: Správa uživatelů a bezpečné změny rolí

**Files:**
- Create: `test/user-service.test.js`
- Create: `app/services/user-service.js`
- Modify: `app/services/auth-service.js`

**Interfaces:**
- Consumes: `auth.getSession`, `auth.revokeUserSessions`, repository, audit a AccessControl.
- Produces: `createUserService({ repository, auth, audit, now })`.
- Metody: `listUsers(sessionId, { query, role, status })`, `getUser(sessionId, userId)`, `createPrivilegedUser(sessionId, input)`, `setUserStatus(sessionId, userId, status)`, `changeUserRole(sessionId, userId, role, transferNormsToUserId)`.

- [ ] **Step 1: Zapsat neúspěšné testy filtrování a založení správce**

Ověřit hledání bez ohledu na velikost písmen přes `firstName`, `lastName`, `email`, `sokolUnit` a `membershipId`. `createPrivilegedUser` musí odmítnout administrátora, přijmout superadministrátora a vrátit `set_password` delivery pro účet ve stavu `invited`.

- [ ] **Step 2: Zapsat neúspěšné testy ochranných pravidel**

Testovat odmítnutí blokace nebo degradace posledního aktivního superadministrátora, okamžité zrušení relací blokovaného účtu a odmítnutí degradace administrátora vlastnícího normy bez platného `transferNormsToUserId`.

- [ ] **Step 3: Implementovat službu správy uživatelů**

`createPrivilegedUser` přijme pouze role `admin` nebo `superadmin`; e-mail normalizuje přes `trim().toLowerCase()`. Povýšení člena nastaví `status: "invited"`, zruší relace a vytvoří výzvu `set_password`. Degradace správce převede všechny jeho normy na cílového aktivního správce, smaže `passwordHash`, `passwordSalt`, `passwordUpdatedAt`, zruší relace a ponechá ověřený e-mail.

- [ ] **Step 4: Zapsat audit všech změn**

Použít akce `user.created`, `user.status_changed`, `user.role_changed` a `norm.ownership_transferred`; metadata obsahují starou a novou hodnotu, nikdy heslo ani token.

- [ ] **Step 5: Ověřit testy**

Run: `pnpm test -- test/user-service.test.js test/auth-service.test.js`  
Expected: všechny testy PASS.

- [ ] **Step 6: Commit**

```bash
git add app/services/user-service.js app/services/auth-service.js test/user-service.test.js test/auth-service.test.js
git commit -m "feat: add fixed-role user administration"
```

---

### Task 5: Autorizačně chráněná správa norem a účast

**Files:**
- Create: `test/norm-service.test.js`
- Create: `app/services/norm-service.js`
- Modify: `app/domain/demo-data.js`
- Modify: `app/page.js`

**Interfaces:**
- Consumes: repository, audit, `auth.getSession`, `canParticipate`, `canCreateNorm`, `canManageNorm` a file repository.
- Produces: `createNormService({ repository, auth, audit, fileRepository, now })`.
- Metody čtení: `listPublicNorms(filter)`, `getPublicNorm(normId, user?)`, `listManageable(sessionId)`.
- Metody změn: `create(sessionId, input, file)`, `update(sessionId, normId, patch)`, `remove(sessionId, normId)`, `replaceDocument(sessionId, normId, file)`, `addContribution(sessionId, normId, input)`, `reply(sessionId, normId, submissionId, text)`, `voteSubmission(sessionId, normId, submissionId, direction)`, `voteNeed(sessionId, normId, value)` a `resolveSubmission(sessionId, normId, submissionId, resolution)`.

- [ ] **Step 1: Zapsat neúspěšné testy vlastnictví norem**

Ověřit, že nová norma dostane `ownerAdminId` autora a další číslo řady; administrátor A ji upraví, administrátor B dostane `AuthorizationError` i při přímém volání služby a superadministrátor ji upraví. Stejnou matici použít pro smazání, soubor, stav, uzavření sběru, odpověď a vypořádání.

- [ ] **Step 2: Zapsat neúspěšné testy účasti**

Ověřit, že veřejnost a blokovaný účet nemohou přispívat ani hlasovat, přihlášený ověřený uživatel může, uzavřená norma odmítne nový příspěvek a každý uživatel má nejvýše jeden aktuální hlas na podnět i potřebnost normy.

- [ ] **Step 3: Implementovat službu a audit**

Příspěvek odvozuje `authorUserId`, zobrazované jméno a jednotu z relace; formulář nesmí přijímat autora od uživatele. Hlasy uložit do `state.votes` pod složenými klíči uživatele, normy a cíle. Auditovat správcovské změny a odmítnuté pokusy akcí `authorization.denied`.

- [ ] **Step 4: Přesměrovat změnovou logiku z `page.js` na `norm-service.js`**

Odstranit přímé `setNorms` mutace z handlerů `castVote`, `replaceDocument`, `deleteNorm`, `createNorm`, `submitContribution`, `addReply` a `resolveSubmission`. Handlery volají službu, obnoví snapshot přes repository a zobrazí vrácenou českou zprávu.

- [ ] **Step 5: Ověřit testy a build**

Run: `pnpm test -- test/norm-service.test.js test/access-control.test.js && pnpm build`  
Expected: PASS a úspěšný build.

- [ ] **Step 6: Commit**

```bash
git add app/services/norm-service.js app/domain/demo-data.js app/page.js test/norm-service.test.js test/access-control.test.js
git commit -m "feat: enforce norm ownership and verified participation"
```

---

### Task 6: Přihlašovací rozhraní a aplikační relace

**Files:**
- Create: `test/auth-dialog.test.js`
- Create: `test/user-menu.test.js`
- Create: `app/hooks/use-app-controller.js`
- Create: `app/components/auth/AuthDialog.js`
- Create: `app/components/auth/DemoInbox.js`
- Create: `app/components/auth/UserMenu.js`
- Create: `app/components/shared/Feedback.js`
- Modify: `app/page.js`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: služby Tasks 2–5.
- Produces: `useAppController()` s `state`, `session`, `currentUser`, `view`, `actions` a `feedback`.
- `AuthDialog` přijímá `{ authMode, onClose, onAuthenticated, authService }`.
- `DemoInbox` přijímá `{ deliveries, onUseCode, onOpenLink }`.
- `UserMenu` přijímá `{ currentUser, onLogin, onProfile, onLogout }`.

- [ ] **Step 1: Zapsat neúspěšný test registrace a členského přihlášení**

Testing Library musí projít vyplnění pěti registračních polí, zobrazení simulovaného kódu, chybný kód, správný kód a zavření dialogu po vzniku relace. Samostatně ověřit, že známý člen po zadání e-mailu přejde přímo na krok s novým kódem.

- [ ] **Step 2: Zapsat neúspěšný test správcovského přihlášení a obnovy**

Po zadání `administrator@sokol.demo` se zobrazí pole hesla, nikoli kódu. Ověřit neutrální potvrzení obnovy, otevření demo odkazu, validaci hesla a úspěšné přihlášení novým heslem.

- [ ] **Step 3: Implementovat dialog jako explicitní stavový automat**

Použít stavy `identify`, `register`, `member-code`, `password`, `forgot-password`, `set-password` a `done`. Přechod určuje výsledek služby, ne text zadané domény. Chyby vykreslit do prvku `role="alert"`; první pole nového kroku zaostřit.

- [ ] **Step 4: Implementovat simulovanou schránku a demo panel**

Schránka zobrazuje pouze delivery vytvořené v aktuálním prohlížeči. Panel „Vyzkoušet demoverzi“ uvádí tři modelové účty a jejich testovací hesla nebo kód přesně podle specifikace a výrazně je označuje jako neprodukční údaje.

- [ ] **Step 5: Implementovat řadič a uživatelské menu**

Řadič při startu načte `sessionId` z `sessionStorage`, zavolá `auth.getSession`, inicializuje demo hesla a při každé změně načte nový snapshot. Neplatnou relaci odstraní. Nepřihlášený stav nabízí „Přihlásit“, přihlášený zobrazuje jméno, roli, profil a „Odhlásit“.

- [ ] **Step 6: Ověřit komponentové testy a build**

Run: `pnpm test -- test/auth-dialog.test.js test/user-menu.test.js && pnpm build`  
Expected: PASS a build bez browser-global chyby při sestavení.

- [ ] **Step 7: Commit**

```bash
git add app/hooks app/components/auth app/components/shared app/page.js app/globals.css test/auth-dialog.test.js test/user-menu.test.js
git commit -m "feat: add adaptive password and code login UI"
```

---

### Task 7: Administrace uživatelů ve variantě A

**Files:**
- Create: `test/user-administration.test.js`
- Create: `app/components/admin/UserAdministration.js`
- Modify: `app/hooks/use-app-controller.js`
- Modify: `app/page.js`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `userService.listUsers`, `getUser`, `createPrivilegedUser`, `setUserStatus`, `changeUserRole` a `auditService.listForTarget`.
- Produces: `UserAdministration({ currentUser, users, selectedUser, auditEvents, actions })`.

- [ ] **Step 1: Zapsat neúspěšný test přístupnosti obrazovky**

Ověřit, že navigaci „Uživatelé“ vidí pouze superadministrátor. Přímé vykreslení s administrátorem musí ukázat autorizační hlášku bez tabulky.

- [ ] **Step 2: Zapsat neúspěšný test layoutu tabulka–filtry–detail**

Test vyhledá uživatele podle jednoty a členského ID, filtruje roli a stav, vybere řádek, zobrazí boční detail a auditní historii. Ověřit souhrn stavů `active`, `invited` a `blocked`.

- [ ] **Step 3: Zapsat neúspěšný test správcovských akcí**

Ověřit založení administrátora, zobrazení odkazu pro první heslo, blokaci a aktivaci, povýšení člena a odmítnutí degradace vlastníka normy bez výběru nového vlastníka.

- [ ] **Step 4: Implementovat komponentu podle schváleného layoutu A**

Desktop: filtry nad tabulkou a detail v pravém panelu. Pod 760 px: každý řádek je přístupné shrnutí, detail se otevře pod tabulkou jako celostránkový panel se zpětným tlačítkem. Všechny akce vyžadují potvrzení, pokud ruší relaci nebo převádějí vlastnictví.

- [ ] **Step 5: Napojit řadič a navigaci**

Přidat view `users`. Řadič načítá filtrovaná data přes `userService`; komponenta nesmí filtrovat nebo měnit role obcházením služby.

- [ ] **Step 6: Ověřit testy a build**

Run: `pnpm test -- test/user-administration.test.js test/user-service.test.js && pnpm build`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/components/admin/UserAdministration.js app/hooks/use-app-controller.js app/page.js app/globals.css test/user-administration.test.js
git commit -m "feat: add superadmin user management workspace"
```

---

### Task 8: Role-aware normy, profil a veřejná účast

**Files:**
- Create: `test/norm-views.test.js`
- Create: `test/member-profile.test.js`
- Create: `app/components/admin/NormAdministration.js`
- Create: `app/components/member/MemberProfile.js`
- Create: `app/components/public/LandingPage.js`
- Create: `app/components/public/NormDetail.js`
- Modify: `app/hooks/use-app-controller.js`
- Modify: `app/page.js`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `normService` veřejné i změnové metody, `canParticipate`, `canManageNorm` a data řadiče.
- Produces: `LandingPage({ norms, filter, onFilter, onOpen })`.
- Produces: `NormDetail({ norm, currentUser, permissions, actions })`.
- Produces: `NormAdministration({ norms, selectedNorm, currentUser, actions })`.
- Produces: `MemberProfile({ user, contributions, votes })`.

- [ ] **Step 1: Zapsat neúspěšný test veřejného a přihlášeného detailu**

Veřejnost vidí důvodovou zprávu, dokument, podněty a výsledky, ale kliknutí na komentář či hlas otevře přihlášení. Aktivní ověřený uživatel může příspěvek a hlas odeslat; formulář nezobrazuje editovatelná pole autora a jednoty.

- [ ] **Step 2: Zapsat neúspěšný test administrace norem**

Administrátor vidí nadpis „Moje normy“ a pouze vlastní normy; superadministrátor vidí „Všechny normy“. Tlačítko „Spravovat“ se na detailu zobrazí jen tehdy, když `canManageNorm` vrátí `true`.

- [ ] **Step 3: Zapsat neúspěšný test členského profilu**

Profil zobrazuje jméno, e-mail, jednotu, členské ID, ověření e-mailu a pouze příspěvky a hlasy navázané na `currentUser.id`.

- [ ] **Step 4: Rozdělit monolitickou stránku do čtyř obrazovek**

Přesunout existující markup beze změny veřejného obsahu do uvedených komponent. `page.js` ponechat jako sestavení topbaru, view switche, modálů a feedbacku; nemá obsahovat doménové mutace.

- [ ] **Step 5: Nahradit všechny přímé akce oprávněnými actions řadiče**

`NormDetail` dostává `permissions: { canParticipate, canManage }`. Zakázané akce volají `actions.requireLogin(intent)` nebo zobrazí důvod uzavření; nikdy nemění lokální objekt normy. `NormAdministration` čerpá výhradně z `normService.listManageable(sessionId)`.

- [ ] **Step 6: Ověřit komponenty, regresi služeb a build**

Run: `pnpm test -- test/norm-views.test.js test/member-profile.test.js test/norm-service.test.js && pnpm build`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/components/admin/NormAdministration.js app/components/member app/components/public app/hooks/use-app-controller.js app/page.js app/globals.css test/norm-views.test.js test/member-profile.test.js
git commit -m "feat: integrate role-aware participation and norm views"
```

---

### Task 9: Kompletní scénáře, responzivita a dokumentace

**Files:**
- Create: `test/access-workflows.test.js`
- Modify: `app/globals.css`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: všechny veřejné služby a komponenty z Tasks 1–8.
- Produces: ověřenou demoverzi a přesný provozní handoff bez nového aplikačního API.

- [ ] **Step 1: Zapsat integrační testy dvanácti přejímacích scénářů**

V `test/access-workflows.test.js` použít skutečné služby s in-memory Storage fake a deterministickým crypto adaptérem. Každý scénář ze sekce 10 specifikace má vlastní `it(...)`; scénáře musí zahrnout expiraci relace, blokaci, obnovu hesla, posledního superadministrátora, vlastnictví normy, audit a veřejné čtení.

- [ ] **Step 2: Spustit celý testovací soubor a odstranit každou regresi v nejnižší odpovědné vrstvě**

Run: `pnpm test -- test/access-workflows.test.js`  
Expected: 12 přejímacích testů PASS.

- [ ] **Step 3: Dokončit mobilní a přístupné styly**

Pro šířku do 760 px ověřit: přihlašovací kroky bez horizontálního posunu, minimálně 44px dotykové cíle, tabulku uživatelů převedenou na čitelné řádky, boční detail pod seznamem, formuláře v jednom sloupci a sticky prvky vrácené do běžného toku. Dialogy musí mít viditelný focus, popisky polí, `aria-modal="true"` a obnovu focusu po zavření.

- [ ] **Step 4: Aktualizovat dokumentaci a ignorovat vizuální pracovní soubory**

README doplní modelové účty, lokální spuštění, `pnpm test`, rozlišení heslo/kód a viditelné varování, že demo není produkčně bezpečné. `docs/ARCHITECTURE.md` popíše nové služby, klientskou hranici a produkční náhradu serverovou autentizací a autorizací. Do `.gitignore` přidat `.superpowers/`.

- [ ] **Step 5: Spustit úplné automatické ověření**

Run: `pnpm test && pnpm build`  
Expected: všechny testy PASS, build skončí exit kódem 0 a vytvoří Sites artefakt v `dist`.

- [ ] **Step 6: Provést ruční smoke test ve dvou rozměrech**

Spustit `pnpm dev` a projít modelové účty v desktopu 1440×900 a mobilu 390×844. Ověřit veřejný detail, členský kód `260814`, obě správcovská hesla, založení administrátora, první heslo, obnovu hesla, omezení cizí normy, profil, komentář a hlasování. V konzoli nesmí být neošetřená chyba.

- [ ] **Step 7: Zkontrolovat tajné údaje a pracovní strom**

Run: `git grep -n -E "passwordHash|passwordSalt|demoToken|demoCode" -- ':!docs/superpowers/**'`  
Expected: pouze definované doménové použití; žádný auditní výpis ani produkční tajný údaj.  
Run: `git status --short`  
Expected: pouze zamýšlené soubory této úlohy.

- [ ] **Step 8: Commit**

```bash
git add test/access-workflows.test.js app/globals.css README.md docs/ARCHITECTURE.md .gitignore
git commit -m "docs: finalize access administration demo"
```

---

## Final Verification Gate

Před označením implementace za dokončenou použít `superpowers:verification-before-completion` a čerstvě spustit:

```bash
pnpm test
pnpm build
git status --short
```

Výsledek musí obsahovat všechny testy PASS, úspěšný Sites build a žádné neočekávané změny. Veřejné nasazení je samostatný krok a není tímto plánem automaticky autorizováno.

