# Member Document Participation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zprovoznit v serverovém pilotu převedený DOCX, bezpečné stažení originálu, blokové komentáře, návrhy, odpovědi a hlasování a změnit MFA tak, aby ji vyžadoval jen superadministrátor.

**Architecture:** Nový veřejně bezpečný read model spojí poslední publikovanou připravenou verzi, bloky a vlákna. Samostatná comment service bude provádět autentizované transakční mutace s CSRF, idempotencí, optimistic concurrency, auditem a outboxem. Klient načte detail při otevření normy a vykreslí stejné strukturované bloky jako administrační náhled.

**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL, Zod, Vitest, Testing Library, Azure Blob/Azurite.

**Spec:** `docs/superpowers/specs/2026-08-27-member-document-participation-design.md`

## Global Constraints

- Zachovat všechny existující necommitnuté změny větve `codex/local-pilot`.
- Běžný administrátor používá jen heslo; TOTP zůstává povinné pro superadministrátora.
- Člen používá vždy nový šestimístný e-mailový kód a nikdy heslo.
- Anonymní veřejný detail nesmí obsahovat e-mail, členské ID, interní user ID ani file ID.
- Každá mutace vyžaduje relaci, CSRF a idempotency key; cílová verze se kontroluje serverem.
- Pilotní databázi `sokol_pilot` ani storage volume nemaž; nepoužívej `down -v`.

---

### Task 1: Role-specific administrator authentication

**Files:**
- Modify: `server/modules/identity/auth-service.ts`
- Modify: `app/api/auth/admin/password/route.ts`
- Modify: `app/components/auth/AuthDialog.js`
- Modify: `app/data/server-api-client.js`
- Modify: `test/server/auth-workflows.test.ts`
- Modify: `test/server/server-security.test.ts`
- Modify: `test/auth-dialog.test.js`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: password endpoint returns a committed session for `admin` and `{ kind: "mfa_required", loginAttemptId }` for `superadmin`.
- Produces: setup returns `{ kind: "password_ready" }` for `admin` or `{ kind: "mfa_enrollment_required", setupAttemptId }` for `superadmin`.

- [ ] Write failing service and route tests proving admin password-only login and superadmin MFA.
- [ ] Run the focused tests and confirm they fail on the current mandatory-MFA behavior.
- [ ] Implement role-specific session creation, setup activation and route cookie commit.
- [ ] Update AuthDialog access choice and server client result adaptation.
- [ ] Run focused auth and dialog tests to green.

### Task 2: Public document detail and authenticated original download

**Files:**
- Modify: `contracts/documents.ts`
- Modify: `contracts/api.ts`
- Create: `server/modules/documents/public-document-detail-repository.ts`
- Create: `server/modules/documents/public-document-detail-service.ts`
- Modify: `server/modules/files/file-download-service.ts`
- Modify: `server/runtime.ts`
- Create: `app/api/public/documents/[publicId]/route.ts`
- Create: `app/api/public/documents/[publicId]/original-download-link/route.ts`
- Create: `test/server/public-document-detail.test.ts`
- Modify: `test/server/file-download-service.test.ts`

**Interfaces:**
- Produces: `getPublicDocumentDetail(actor, publicId)` with public metadata, version, blocks, threads and vote summaries.
- Produces: `createPublicOriginalReadLink(actor, publicId)` without accepting or exposing a file UUID.

- [ ] Write failing integration tests for public blocks, title-only access, redaction and member DOCX download.
- [ ] Run focused tests and confirm missing-service failures.
- [ ] Implement strict contracts, repeatable-read query and authenticated original link.
- [ ] Add read-only routes and runtime wiring.
- [ ] Run focused detail and download tests to green.

### Task 3: Transactional comments, replies and votes

**Files:**
- Create: `server/db/migrations/0013_comment_participation.sql`
- Modify: `test/server/db-test-context.ts`
- Modify: `contracts/comments.ts`
- Create: `server/modules/comments/comment-repository.ts`
- Create: `server/modules/comments/comment-service.ts`
- Modify: `server/runtime.ts`
- Create: `app/api/public/documents/[publicId]/blocks/[blockUid]/comments/route.ts`
- Create: `app/api/public/comments/[commentPublicId]/replies/route.ts`
- Create: `app/api/public/comments/[commentPublicId]/vote/route.ts`
- Create: `app/api/public/documents/[publicId]/need-vote/route.ts`
- Create: `test/server/comment-workflows.test.ts`
- Create: `test/server/comment-routes.test.ts`

**Interfaces:**
- Produces: `createComment`, `reply`, `voteComment`, `voteNeed` commands returning the refreshed public detail fragments.
- Consumes: stable `publicId`, `blockUid`, comment public ID, CSRF, idempotency key and `If-Match`.

- [ ] Write and run failing migration/service tests for comment, proposal, reply, vote and closed-document rejection.
- [ ] Add vote/sequence schema and update test reset order.
- [ ] Implement transactional service with verified-member, current-block, state, concurrency, audit and outbox checks.
- [ ] Write and run failing route tests for CSRF, idempotency and validation.
- [ ] Implement routes and run all comment tests to green.

### Task 4: Member document UI and explicit access choice

**Files:**
- Create: `app/components/shared/StructuredBlockContent.js`
- Modify: `app/components/admin/ConversionPreview.js`
- Modify: `app/components/public/NormDetail.js`
- Modify: `app/data/server-api-client.js`
- Modify: `app/hooks/use-app-controller.js`
- Modify: `app/page.js`
- Modify: `app/globals.css`
- Modify: `test/norm-views.test.js`
- Modify: `test/server/server-api-client.test.js`
- Modify: `test/auth-dialog.test.js`
- Modify: `test/app-controller-recovery.test.js`

**Interfaces:**
- Consumes: public detail and comment endpoints from Tasks 2–3.
- Produces: detail loading state, structured block cards, per-block comment/proposal actions, replies, votes and original download.

- [ ] Write failing component/client tests for access choice, block rendering and every enabled action.
- [ ] Run focused UI tests and confirm the current empty/stub behavior fails.
- [ ] Extract shared safe structured renderer and adapt the admin preview.
- [ ] Implement detail loading, refresh after mutation, signed DOCX download and per-block controls.
- [ ] Run focused UI/client/controller tests to green.

### Task 5: Pilot migration and end-to-end verification

**Files:**
- Modify: `scripts/smoke-local-pilot-ui.mjs`
- Modify: `docs/operations/local-pilot.md`
- Create: `docs/verification/2026-08-27-member-participation-verification.md`

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: repeatable acceptance evidence for login, reload, block mutation and download.

- [ ] Extend smoke to cover member login, reload, visible converted blocks and proposal mutation.
- [ ] Migrate/restart pilot with volume-preserving commands and verify `pilot:status`.
- [ ] Run focused tests, `pnpm test`, `pnpm typecheck`, browser build and server build.
- [ ] Run `pnpm pilot:smoke-ui`, manually inspect the member detail and record limitations.
- [ ] Run `git diff --check`, inspect the exact diff and write the fresh verification report.
