# Production Foundation and Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Převést stávající pilot z browserového zdroje dat na produkční serverový základ s PostgreSQL, serverovým přihlášením, auditem, správou uživatelů a dokumentů, aniž by se přepisovalo ověřené UI.

**Architecture:** Stávající React komponenty zůstávají zachované. Nový modulární server v téže Next.js aplikaci poskytne pouze stejnodoménové interní `/api`; PostgreSQL bude zdrojem pravdy a transakční outbox/audit budou součástí každé důležité změny. Browserový repository zůstane dočasně dostupný jen explicitním demo přepínačem, takže veřejný pilot může běžet během migrace.

**Tech Stack:** React 19, Next.js 16, TypeScript, Zod, PostgreSQL 16, `postgres`, `@node-rs/argon2`, `otplib`, Vitest 4, Testing Library, Docker Compose, OpenTelemetry-ready structured logging.

## Global Constraints

- První tři roky se dimenzují na nejvýše 10 000 registrovaných uživatelů s návrhovou rezervou přibližně do 50 000.
- Produkční nasazení má dvě části: webová aplikace se stejnodoménovým interním API a asynchronní worker; tento plán implementuje pouze první část.
- Veřejné integrační API, API klíče, webhooky, GraphQL a členské API nejsou součástí této etapy.
- Role jsou pouze `member`, `admin` a `superadmin`; veřejný návštěvník nemá uživatelský účet.
- Administrátor spravuje pouze dokumenty, jejichž je vlastníkem; superadministrátor spravuje všechny a může vlastnictví převést.
- Běžný uživatel se přihlašuje šestiznakovým e-mailovým kódem; administrátor a superadministrátor heslem Argon2id a povinným TOTP MFA.
- E-mail, členské ID a interní UUID jsou neveřejné.
- Server ověřuje relaci, roli, vlastnictví, stav a `row_version` při každé změně.
- Důležité zápisy vznikají v jedné DB transakci spolu s auditní a případnou outbox událostí.
- Stávající browserová demoverze a jejích 138 regresních testů musí během etapy zůstat funkční.
- Nové serverové chování se implementuje test-first; každý úkol musí nejdříve prokázat očekávané selhání a následně zelený test.
- Produkční tajné hodnoty, hesla, OTP, TOTP secrets, cookies a bearer hodnoty se nikdy nelogují.

## File and boundary map

Nové soubory jsou rozděleny podle odpovědnosti, nikoli pouze podle technické vrstvy:

- `contracts/` — stabilní typy, Zod schémata a problem details sdílené browserem a serverem;
- `server/db/` — konfigurace, pool, migrace a transakční helper;
- `server/modules/identity/` — serverové přihlášení, relace, uživatelé a credentials;
- `server/modules/documents/` — dokumenty, vlastnictví a stavové přechody;
- `server/modules/audit/` — jediná cesta pro append-only audit;
- `server/modules/outbox/` — zápis a vyzvedávání transakčních událostí;
- `server/http/` — cookies, CSRF, mapování chyb a autorizovaný request context;
- `app/api/` — tenké Next route handlery bez doménové logiky;
- `app/data/server-api-client.js` — adaptér pro stávající controller a UI;
- `test/server/` — testy kontraktů, databáze, HTTP a serverových workflow;
- `infra/local/` — lokální PostgreSQL a dokumentace vývojového prostředí.

Doménové typy definované v Task 1 jsou autoritativní. Pozdější úkol je nesmí přejmenovat nebo duplikovat.

---

### Task 1: Authoritative contracts and compatibility boundary

**Files:**
- Create: `contracts/access.ts`
- Create: `contracts/users.ts`
- Create: `contracts/documents.ts`
- Create: `contracts/api.ts`
- Create: `contracts/index.ts`
- Create: `test/server/contracts.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tsconfig.json`

**Interfaces:**
- Consumes: současné hodnoty rolí a stavů z `app/domain/constants.js`.
- Produces: `Role`, `UserStatus`, `Actor`, `PublicUser`, `ViewerUser`, `AdminUserView`, `DocumentStatus`, `PublicDocumentSummary`, `DocumentAdminView`, `AppSnapshot`, `ApiProblem`, `VersionedCommand` a jejich Zod schémata.

- [ ] **Step 1: Add only the shared-contract dependencies and TypeScript configuration**

Run:

```powershell
pnpm add zod
pnpm add -D typescript @types/node
```

Create `tsconfig.json` with strict checking while allowing the existing JavaScript UI:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": true,
    "checkJs": false,
    "strict": true,
    "noEmit": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "jsx": "preserve",
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "contracts/**/*.ts", "server/**/*.ts", "app/**/*.ts", "app/**/*.tsx", "test/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Add scripts without changing the existing pilot commands:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:server": "vitest run test/server",
    "dev:server": "next dev",
    "build:server": "next build",
    "start:server": "next start"
  }
}
```

- [ ] **Step 2: Write the failing contract test**

Create `test/server/contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  appSnapshotSchema,
  documentAdminViewSchema,
  roleSchema,
  userStatusSchema,
} from "../../contracts/index";

describe("authoritative server contracts", () => {
  it("keeps the approved role and user-status literals", () => {
    expect(roleSchema.options).toEqual(["member", "admin", "superadmin"]);
    expect(userStatusSchema.options).toEqual([
      "invited",
      "pending_verification",
      "active",
      "blocked",
    ]);
  });

  it("requires owner and row version on every administrative document view", () => {
    expect(() => documentAdminViewSchema.parse({ publicId: "SOKOL-2026-001", title: "Norma" })).toThrow();
  });

  it("never exposes private member fields in the public snapshot shape", () => {
    const snapshot = appSnapshotSchema.parse({
      viewer: null,
      documents: [],
      managedDocuments: [],
      organizations: [],
      capabilities: { manageUsers: false, createDocument: false },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/"(email|membershipId|passwordHash)"\s*:/i);
  });
});
```

- [ ] **Step 3: Run the test and confirm the intended RED state**

Run: `pnpm vitest run test/server/contracts.test.ts`

Expected: FAIL because `contracts/index.ts` and schemas do not exist.

- [ ] **Step 4: Implement the exact shared types and schemas**

Create `contracts/access.ts`:

```ts
import { z } from "zod";

export const roleSchema = z.enum(["member", "admin", "superadmin"]);
export const userStatusSchema = z.enum([
  "invited",
  "pending_verification",
  "active",
  "blocked",
]);
export type Role = z.infer<typeof roleSchema>;
export type UserStatus = z.infer<typeof userStatusSchema>;

export const actorSchema = z.object({
  userId: z.string().uuid(),
  role: roleSchema,
  sessionId: z.string().uuid(),
});
export type Actor = z.infer<typeof actorSchema>;
```

Create `contracts/users.ts` with separate public and administrative projections:

```ts
import { z } from "zod";
import { roleSchema, userStatusSchema } from "./access";

export const publicUserSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  organizationName: z.string().min(1),
  role: roleSchema,
});

export const viewerUserSchema = publicUserSchema.extend({
  id: z.string().uuid(),
  emailVerifiedAt: z.string().datetime().nullable(),
});

export const adminUserViewSchema = publicUserSchema.extend({
  id: z.string().uuid(),
  email: z.string().email(),
  membershipId: z.string().nullable(),
  status: userStatusSchema,
  emailVerifiedAt: z.string().datetime().nullable(),
  lastLoginAt: z.string().datetime().nullable(),
  rowVersion: z.number().int().positive(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;
export type ViewerUser = z.infer<typeof viewerUserSchema>;
export type AdminUserView = z.infer<typeof adminUserViewSchema>;
```

Create `contracts/documents.ts`:

```ts
import { z } from "zod";

export const documentStatusSchema = z.enum([
  "concept",
  "file_check",
  "conversion",
  "conversion_review",
  "ready",
  "published_open",
  "comments_closed",
  "settlement",
  "settled",
  "approved",
  "rejected",
  "archived",
]);

export const publicDocumentSummarySchema = z.object({
  publicId: z.string().regex(/^SOKOL-\d{4}-\d{3,}$/),
  title: z.string().min(1),
  explanatoryReport: z.string(),
  responsibleAdminName: z.string().min(1),
  status: documentStatusSchema,
  commentsOpen: z.boolean(),
  visibilityMode: z.enum(["public_detail", "login_required_detail"]),
  fourEyesRequired: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const documentAdminViewSchema = publicDocumentSummarySchema.extend({
  id: z.string().uuid(),
  ownerAdminId: z.string().uuid(),
  closureReason: z.string(),
  rowVersion: z.number().int().positive(),
});

export type DocumentStatus = z.infer<typeof documentStatusSchema>;
export type PublicDocumentSummary = z.infer<typeof publicDocumentSummarySchema>;
export type DocumentAdminView = z.infer<typeof documentAdminViewSchema>;
```

Create `contracts/api.ts` and `contracts/index.ts`:

```ts
// contracts/api.ts
import { z } from "zod";
import { viewerUserSchema } from "./users";
import { documentAdminViewSchema, publicDocumentSummarySchema } from "./documents";

export const apiProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  code: z.string(),
  correlationId: z.string().uuid(),
});

export const versionedCommandSchema = z.object({
  rowVersion: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
});

export const appSnapshotSchema = z.object({
  viewer: viewerUserSchema.nullable(),
  documents: z.array(publicDocumentSummarySchema),
  managedDocuments: z.array(documentAdminViewSchema),
  organizations: z.array(z.object({ code: z.string().min(1), name: z.string() })),
  capabilities: z.object({ manageUsers: z.boolean(), createDocument: z.boolean() }),
});

export type ApiProblem = z.infer<typeof apiProblemSchema>;
export type VersionedCommand = z.infer<typeof versionedCommandSchema>;
export type AppSnapshot = z.infer<typeof appSnapshotSchema>;

// contracts/index.ts
export * from "./access";
export * from "./users";
export * from "./documents";
export * from "./api";
```

- [ ] **Step 5: Verify contracts and preserve the pilot suite**

Run:

```powershell
pnpm vitest run test/server/contracts.test.ts
pnpm test
pnpm typecheck
```

Expected: contract test PASS, existing 138 tests PASS, TypeScript exits 0.

- [ ] **Step 6: Commit Task 1**

```powershell
git add package.json pnpm-lock.yaml tsconfig.json contracts test/server/contracts.test.ts
git commit -m "feat: define authoritative server contracts"
```

---

### Task 2: PostgreSQL schema, migrations, and real-database test harness

**Files:**
- Create: `infra/local/compose.yaml`
- Create: `.env.example`
- Create: `server/db/config.ts`
- Create: `server/db/client.ts`
- Create: `server/db/migrate.ts`
- Create: `server/db/migrations/0001_foundation.sql`
- Create: `test/server/db-test-context.ts`
- Create: `test/server/database-foundation.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: role, status and document literals from `contracts/`.
- Produces: `createDatabase(url): Sql`, `withTransaction<T>(sql, work): Promise<T>` and `resetTestDatabase(): Promise<void>`.

- [ ] **Step 1: Add the database dependency and local commands**

Run: `pnpm add postgres`

Add package scripts:

```json
{
  "db:up": "docker compose -f infra/local/compose.yaml up -d --wait",
  "db:down": "docker compose -f infra/local/compose.yaml down",
  "db:migrate": "tsx server/db/migrate.ts",
  "test:server:db": "vitest run test/server/database-foundation.test.ts"
}
```

Also install the script runner: `pnpm add -D tsx`.

- [ ] **Step 2: Create the isolated PostgreSQL 16 service**

Create `infra/local/compose.yaml`:

```yaml
services:
  postgres:
    image: postgres:16.4-alpine
    environment:
      POSTGRES_DB: sokol_test
      POSTGRES_USER: sokol
      POSTGRES_PASSWORD: local-only-password
    ports:
      - "55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sokol -d sokol_test"]
      interval: 2s
      timeout: 3s
      retries: 20
    volumes:
      - sokol_pg_data:/var/lib/postgresql/data
volumes:
  sokol_pg_data:
```

Create `.env.example`:

```dotenv
DATABASE_URL=postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test
SESSION_HMAC_KEY=replace-with-32-byte-random-secret
OTP_HMAC_KEY=replace-with-different-32-byte-random-secret
TOTP_ENCRYPTION_KEY=replace-with-32-byte-base64-key
APP_ORIGIN=http://localhost:3000
DATA_BACKEND=server
```

Add `.env`, `.env.local`, and `.env.test.local` to `.gitignore` without ignoring `.env.example`.

- [ ] **Step 3: Write the RED database test**

Create `test/server/database-foundation.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { testSql, migrateTestDatabase, resetTestDatabase } from "./db-test-context";

beforeAll(async () => {
  await migrateTestDatabase();
  await resetTestDatabase();
});

describe("foundation migration", () => {
  it("creates the phase A tables and constraints", async () => {
    const rows = await testSql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      "organizations", "users", "admin_credentials", "login_challenges",
      "sessions", "documents", "document_state_transitions", "audit_events",
      "outbox_events", "schema_migrations"
    ]));
  });

  it("rejects a document owner who is not an active administrator", async () => {
    const [organization] = await testSql<{ id: string }[]>`
      insert into organizations (code, name) values ('TEST', 'Testovací jednota') returning id
    `;
    const [member] = await testSql<{ id: string }[]>`
      insert into users (organization_id, first_name, last_name, email, role, status)
      values (${organization.id}, 'Jan', 'Člen', 'member@example.cz', 'member', 'active') returning id
    `;
    await expect(testSql`
      insert into documents (number, title, owner_admin_id)
      values ('SOKOL-2026-001', 'Test', ${member.id})
    `).rejects.toThrow(/active administrator/);
  });
});
```

- [ ] **Step 4: Run the RED database test**

Run:

```powershell
pnpm db:up
$env:DATABASE_URL='postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test'
pnpm vitest run test/server/database-foundation.test.ts
```

Expected: FAIL because the DB client, migration runner and tables do not exist.

- [ ] **Step 5: Implement connection, migration and the complete phase-A schema**

Create `server/db/client.ts`:

```ts
import postgres, { type Sql } from "postgres";

export function createDatabase(url: string): Sql {
  if (!url) throw new Error("DATABASE_URL is required");
  return postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10 });
}

export async function withTransaction<T>(sql: Sql, work: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => work(tx as unknown as Sql)) as Promise<T>;
}
```

Create `server/db/config.ts` to read and validate only server-side environment values:

```ts
import { z } from "zod";

const schema = z.object({ DATABASE_URL: z.string().url() });
export function databaseConfig(env = process.env) {
  return schema.parse({ DATABASE_URL: env.DATABASE_URL });
}
```

Create `server/db/migrations/0001_foundation.sql`. It must enable `pgcrypto` and `citext`, create enums for the approved role/status values, and create all ten phase-A tables. Use these mandatory columns and constraints:

```sql
create extension if not exists pgcrypto;
create extension if not exists citext;

create type user_role as enum ('member', 'admin', 'superadmin');
create type user_status as enum ('invited', 'pending_verification', 'active', 'blocked');
create type document_status as enum (
  'concept', 'file_check', 'conversion', 'conversion_review', 'ready',
  'published_open', 'comments_closed', 'settlement', 'settled',
  'approved', 'rejected', 'archived'
);

create table schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  first_name text not null check (length(trim(first_name)) > 0),
  last_name text not null check (length(trim(last_name)) > 0),
  email citext not null unique,
  membership_id text,
  role user_role not null,
  status user_status not null,
  email_verified_at timestamptz,
  last_login_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table admin_credentials (
  user_id uuid primary key references users(id) on delete restrict,
  password_hash text not null,
  totp_secret_ciphertext bytea,
  totp_enabled_at timestamptz,
  password_updated_at timestamptz not null default now()
);

create table login_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  pending_email citext,
  kind text not null check (kind in (
    'member_code', 'set_password', 'reset_password', 'admin_mfa', 'mfa_enrollment'
  )),
  secret_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  used_at timestamptz,
  locked_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (user_id is not null or pending_email is not null)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  csrf_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_from_id uuid references sessions(id)
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  number text not null unique check (number ~ '^SOKOL-[0-9]{4}-[0-9]{3,}$'),
  title text not null check (length(trim(title)) > 0),
  explanatory_report text not null default '',
  owner_admin_id uuid not null references users(id) on delete restrict,
  status document_status not null default 'concept',
  comments_open boolean not null default false,
  visibility_mode text not null default 'public_detail'
    check (visibility_mode in ('public_detail', 'login_required_detail')),
  four_eyes_required boolean not null default false,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table document_state_transitions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete restrict,
  actor_user_id uuid not null references users(id) on delete restrict,
  from_status document_status,
  to_status document_status not null,
  reason text,
  created_at timestamptz not null default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete restrict,
  actor_role user_role,
  action text not null,
  target_type text not null,
  target_id uuid,
  outcome text not null check (outcome in ('allowed', 'denied')),
  correlation_id uuid not null,
  metadata jsonb not null default '{}',
  previous_hash text,
  event_hash text not null unique,
  created_at timestamptz not null default now()
);

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  payload jsonb not null,
  idempotency_key uuid not null unique,
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);

create index users_role_status_idx on users(role, status);
create index documents_owner_status_idx on documents(owner_admin_id, status);
create index login_challenges_user_kind_idx on login_challenges(user_id, kind, created_at desc);
create index sessions_user_active_idx on sessions(user_id, expires_at) where revoked_at is null;
create index audit_events_target_idx on audit_events(target_type, target_id, created_at);
create index outbox_pending_idx on outbox_events(available_at) where processed_at is null;

create function assert_document_owner_is_admin() returns trigger language plpgsql as $$
declare owner_role user_role; owner_status user_status;
begin
  select role, status into owner_role, owner_status from users where id = new.owner_admin_id;
  if owner_role not in ('admin', 'superadmin') or owner_status <> 'active' then
    raise exception 'document owner must be an active administrator';
  end if;
  return new;
end $$;

create trigger documents_owner_guard before insert or update of owner_admin_id on documents
for each row execute function assert_document_owner_is_admin();
```

The test helper must run the ordered SQL migrations once and truncate mutable tables in reverse dependency order between tests. Do not use an in-memory PostgreSQL emulator. It must export these fixtures for later tasks:

```ts
export const testSql = createDatabase(process.env.DATABASE_URL!);
export async function migrateTestDatabase(): Promise<void>;
export async function resetTestDatabase(): Promise<void>;
export async function seedOrganization(input?: { code?: string; name?: string }): Promise<{ id: string }>;
export async function seedActiveMember(input?: { email?: string }): Promise<{ id: string; email: string }>;
export async function seedActiveAdmin(input?: { email?: string; role?: "admin" | "superadmin" }): Promise<{ id: string; email: string }>;
```

- [ ] **Step 6: Verify migration behavior against real PostgreSQL**

Run:

```powershell
pnpm vitest run test/server/database-foundation.test.ts
pnpm typecheck
```

Expected: both tests PASS; invalid owner transaction is rejected by PostgreSQL.

- [ ] **Step 7: Commit Task 2**

```powershell
git add infra/local .env.example .gitignore package.json pnpm-lock.yaml server/db test/server
git commit -m "feat: add postgres foundation schema"
```

---

### Task 3: Transactional audit and outbox

**Files:**
- Create: `server/modules/audit/audit-writer.ts`
- Create: `server/modules/outbox/outbox-writer.ts`
- Create: `server/modules/shared/command-context.ts`
- Create: `test/server/transactional-audit.test.ts`
- Modify: `server/db/client.ts`

**Interfaces:**
- Consumes: `Actor` and PostgreSQL transaction `Sql`.
- Produces: `CommandContext`, `appendAudit(tx, input)`, `appendOutbox(tx, input)` and `executeCommand(sql, context, work)`.

- [ ] **Step 1: Write tests proving atomicity, denial logging, and redaction**

Create `test/server/transactional-audit.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "../../server/modules/shared/command-context";
import { testSql, resetTestDatabase, seedActiveAdmin } from "./db-test-context";

beforeEach(resetTestDatabase);

describe("transactional audit", () => {
  it("rolls back domain data and audit when the command fails", async () => {
    const actor = await seedActiveAdmin();
    await expect(executeCommand(testSql, {
      actor: { userId: actor.id, role: "admin", sessionId: crypto.randomUUID() },
      action: "document.create",
      targetType: "document",
      correlationId: crypto.randomUUID(),
    }, async (tx) => {
      await tx`insert into outbox_events
        (event_type, aggregate_type, aggregate_id, payload, idempotency_key)
        values ('x', 'document', ${crypto.randomUUID()}, '{}', ${crypto.randomUUID()})`;
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await testSql`select * from outbox_events`)).toHaveLength(0);
    expect((await testSql`select * from audit_events`)).toHaveLength(0);
  });

  it("redacts secrets from audit metadata", async () => {
    const actor = await seedActiveAdmin();
    await executeCommand(testSql, {
      actor: { userId: actor.id, role: "admin", sessionId: crypto.randomUUID() },
      action: "auth.changed",
      targetType: "user",
      targetId: actor.id,
      correlationId: crypto.randomUUID(),
      metadata: { email: "a@sokol.cz", password: "secret", token: "secret" },
    }, async () => undefined);
    const [event] = await testSql<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events`;
    expect(event.metadata).toEqual({ email: "a@sokol.cz", password: "[REDACTED]", token: "[REDACTED]" });
  });
});
```

- [ ] **Step 2: Run the RED tests**

Run: `pnpm vitest run test/server/transactional-audit.test.ts`

Expected: FAIL because command context and writers do not exist.

- [ ] **Step 3: Implement shared command context and append-only writers**

Define the exact interface in `server/modules/shared/command-context.ts`:

```ts
import type { Sql } from "postgres";
import type { Actor } from "../../../contracts";

export interface CommandContext {
  actor: Actor | null;
  action: string;
  targetType: string;
  targetId?: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export async function executeCommand<T>(
  sql: Sql,
  context: CommandContext,
  work: (tx: Sql) => Promise<T>,
): Promise<T>;
```

`executeCommand` must open one transaction, run `work`, append an `allowed` audit event, and commit. A rejected authorization uses `appendDeniedAudit` in a short independent transaction because no domain mutation is allowed. `audit-writer.ts` recursively replaces values under keys matching `/password|secret|token|cookie|authorization|code/i` with `[REDACTED]`, canonicalizes JSON keys, calculates `event_hash = SHA-256(previous_hash + canonical_event_json)`, and serializes every append with `select pg_advisory_xact_lock(hashtext('audit_events'))` before reading the previous hash. This also protects creation of the first event, where no row exists to lock.

Define outbox input in `server/modules/outbox/outbox-writer.ts`:

```ts
export interface OutboxInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}
export async function appendOutbox(tx: Sql, input: OutboxInput): Promise<void>;
```

- [ ] **Step 4: Run atomicity tests and the full suite**

Run:

```powershell
pnpm vitest run test/server/transactional-audit.test.ts
pnpm test
pnpm typecheck
```

Expected: new tests PASS, existing 138 tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit Task 3**

```powershell
git add server/modules test/server server/db/client.ts
git commit -m "feat: add transactional audit and outbox"
```

---

### Task 4: Server cryptography, cookies, CSRF, and session context

**Files:**
- Create: `server/modules/identity/secret-service.ts`
- Create: `server/modules/identity/session-repository.ts`
- Create: `server/http/session-cookie.ts`
- Create: `server/http/request-context.ts`
- Create: `server/http/csrf.ts`
- Create: `test/server/server-security.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `Actor`, `users`, `admin_credentials`, `login_challenges`, `sessions`.
- Produces: `SecretService`, `createSession`, `resolveActor`, `revokeSession`, `setSessionCookie`, `clearSessionCookie`, `assertCsrf`.

- [ ] **Step 1: Add cryptographic dependencies**

Run:

```powershell
pnpm add @node-rs/argon2 otplib
```

- [ ] **Step 2: Write RED security tests**

Create `test/server/server-security.test.ts` with exact behaviors:

```ts
import { describe, expect, it } from "vitest";
import { createSecretService } from "../../server/modules/identity/secret-service";
import { sessionCookieOptions } from "../../server/http/session-cookie";

describe("server security primitives", () => {
  const secrets = createSecretService({
    sessionHmacKey: "s".repeat(32),
    otpHmacKey: "o".repeat(32),
  });

  it("stores no recoverable OTP or session token", async () => {
    const otpHash = secrets.hashOtp("challenge-id", "123456");
    const token = secrets.newSessionToken();
    expect(otpHash).not.toContain("123456");
    expect(secrets.hashSessionToken(token)).not.toContain(token);
    expect(secrets.verifyOtp("challenge-id", "123456", otpHash)).toBe(true);
  });

  it("uses the required host-only secure cookie", () => {
    expect(sessionCookieOptions).toMatchObject({
      name: "__Host-sokol_session",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });
});
```

- [ ] **Step 3: Run the RED test**

Run: `pnpm vitest run test/server/server-security.test.ts`

Expected: FAIL because server security primitives do not exist.

- [ ] **Step 4: Implement security primitives**

`SecretService` must expose exactly:

```ts
export interface SecretService {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, encodedHash: string): Promise<boolean>;
  newOtp(): string;
  hashOtp(challengeId: string, code: string): string;
  verifyOtp(challengeId: string, code: string, expectedHash: string): boolean;
  newSessionToken(): string;
  hashSessionToken(token: string): string;
  newCsrfToken(): string;
  hashCsrfToken(token: string): string;
}
```

Implementation rules:

- Argon2id uses memory cost 64 MiB, time cost 3 and parallelism 1; encoded hashes retain parameters for future rehash.
- `newOtp()` uses rejection sampling and always returns `/^\d{6}$/`.
- OTP/session/CSRF hashes use HMAC-SHA-256 with separate keys and `timingSafeEqual`.
- session tokens contain 32 random bytes encoded base64url; only HMAC is stored.
- production startup rejects missing keys and keys shorter than 32 bytes.

`resolveActor(sql, rawCookieToken)` loads only an active, unrevoked, unexpired session and active user, updates no data, and returns `Actor | null`. `createSession` rotates any supplied current session, stores token and CSRF hashes, updates `last_login_at`, and returns raw secrets only to the HTTP layer.

- [ ] **Step 5: Verify security behavior**

Run:

```powershell
pnpm vitest run test/server/server-security.test.ts
pnpm typecheck
```

Expected: PASS and no secret value printed in test output.

- [ ] **Step 6: Commit Task 4**

```powershell
git add package.json pnpm-lock.yaml server/modules/identity server/http test/server/server-security.test.ts
git commit -m "feat: add server session security"
```

---

### Task 5: Member OTP and administrator password plus MFA workflows

**Files:**
- Create: `server/modules/identity/auth-repository.ts`
- Create: `server/modules/identity/auth-service.ts`
- Create: `server/modules/identity/auth-errors.ts`
- Create: `server/modules/identity/totp-vault.ts`
- Create: `server/http/problem-details.ts`
- Create: `app/api/auth/member/request-code/route.ts`
- Create: `app/api/auth/member/verify-code/route.ts`
- Create: `app/api/auth/admin/password/route.ts`
- Create: `app/api/auth/admin/mfa/route.ts`
- Create: `app/api/auth/admin/setup/route.ts`
- Create: `app/api/auth/admin/mfa/enroll/route.ts`
- Create: `app/api/auth/admin/mfa/confirm/route.ts`
- Create: `app/api/auth/admin/reset/request/route.ts`
- Create: `app/api/auth/admin/reset/complete/route.ts`
- Create: `app/api/auth/session/route.ts`
- Create: `app/api/auth/logout/route.ts`
- Create: `test/server/auth-workflows.test.ts`

**Interfaces:**
- Consumes: `SecretService`, session helpers, command context, outbox and audit.
- Produces: `requestMemberCode`, `verifyMemberCode`, `completeAdminSetup`, `beginMfaEnrollment`, `confirmMfaEnrollment`, `requestPasswordReset`, `completePasswordReset`, `verifyAdminPassword`, `verifyAdminMfa`, `logout` and matching HTTP routes.

- [ ] **Step 1: Write RED workflow tests against real PostgreSQL**

The test must cover all approved paths:

```ts
it("registers a member only after a valid six-digit code", async () => {
  const delivery = await auth.requestMemberCode({
    email: "clen@example.cz",
    firstName: "Jan",
    lastName: "Sokol",
    organizationCode: "PRAHA-1",
    membershipId: null,
  });
  expect(delivery.publicResult).toEqual({ accepted: true });
  expect(delivery.testOnlyCode).toMatch(/^\d{6}$/);
  const session = await auth.verifyMemberCode(delivery.challengeId, delivery.testOnlyCode);
  expect(session.user.emailVerifiedAt).not.toBeNull();
});

it("does not reveal whether an unknown email exists", async () => {
  const known = await auth.requestMemberCode({ email: member.email });
  const unknown = await auth.requestMemberCode({ email: "unknown@example.cz" });
  expect(known.publicResult).toEqual(unknown.publicResult);
});

it("requires password and TOTP before creating an admin session", async () => {
  const pending = await auth.verifyAdminPassword(admin.email, "Correct-Horse-1!");
  expect(pending.kind).toBe("mfa_required");
  await expect(auth.resolveSession(pending.loginAttemptId)).rejects.toThrow();
  const session = await auth.verifyAdminMfa(pending.loginAttemptId, validTotp);
  expect(session.user.role).toBe("admin");
});
```

Add these named cases with the stated result; each row is an independent test with a freshly seeded database:

| Test name | Expected result |
|---|---|
| `locks member challenge after fifth invalid code` | fifth attempt returns `CODE_LOCKED`; correct code is then rejected |
| `rejects expired code` | returns `CODE_EXPIRED` and creates no session |
| `rejects consumed code` | second verification returns `CODE_USED` |
| `revokes sibling challenges when issuing a new code` | only the newest challenge can be consumed |
| `blocks both login methods for blocked user` | generic public response; no session row |
| `rotates current session after reauthentication` | old session has `revoked_at`; new token resolves |
| `logout revokes the current session` | subsequent `/api/auth/session` returns 401 |
| `maps invalid JSON and internal error safely` | 400/500 Problem Details without stack or request secrets |

Add setup and recovery tests with these assertions:

```ts
it("activates an invited admin only after password setup and confirmed MFA", async () => {
  const setup = await auth.completeAdminSetup(setupToken, "Correct-Horse-1!");
  const enrollment = await auth.beginMfaEnrollment(setup.setupAttemptId);
  expect(enrollment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
  const session = await auth.confirmMfaEnrollment(setup.setupAttemptId, totpFor(enrollment.testOnlySecret));
  expect(session.user.status).toBe("active");
});

it("consumes a password-reset token once and revokes all existing sessions", async () => {
  const reset = await auth.requestPasswordReset(admin.email);
  await auth.completePasswordReset(reset.testOnlyToken, "Different-Horse-2!");
  await expect(auth.resolveSession(oldSession.token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  await expect(auth.completePasswordReset(reset.testOnlyToken, "Third-Horse-3!"))
    .rejects.toMatchObject({ code: "TOKEN_USED" });
});
```

- [ ] **Step 2: Run the RED workflow test**

Run: `pnpm vitest run test/server/auth-workflows.test.ts`

Expected: FAIL because the server auth service and routes do not exist.

- [ ] **Step 3: Implement the auth repository and service**

Use these limits exactly:

```ts
export const AUTH_LIMITS = {
  otpLifetimeMs: 10 * 60 * 1000,
  maxOtpAttempts: 5,
  adminLoginAttemptMs: 5 * 60 * 1000,
  passwordLinkMs: 30 * 60 * 1000,
  sessionLifetimeMs: 8 * 60 * 60 * 1000,
} as const;
```

Each code request revokes unused sibling challenges of the same kind. The database stores only the HMAC. The readable code is placed in an `identity.member_code_requested` outbox event addressed to the private e-mail; service responses never return it outside `NODE_ENV=test`. Unknown e-mail requests perform equivalent cryptographic work and return the same `202` response.

Admin password verification creates a short-lived server-side MFA login attempt, not a session. TOTP secret encryption uses AES-256-GCM with a random nonce and the `TOTP_ENCRYPTION_KEY`; only successful TOTP creates the session cookie. Blocked users cannot complete either flow.

Admin invitations use a single-use `set_password` token stored only as an HMAC. Completing setup stores the Argon2id hash but keeps the user `invited` until TOTP enrollment is confirmed. Password-reset requests always return the same public response, expire after 30 minutes, revoke unused sibling reset challenges when issued, and revoke all sessions when consumed. Password reset does not disable MFA.

- [ ] **Step 4: Implement thin route handlers and RFC Problem Details**

Every state-changing route must:

```ts
export async function POST(request: Request) {
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  try {
    const input = requestSchema.parse(await request.json());
    const result = await service.operation(input, correlationId);
    return Response.json(result.body, { status: result.status, headers: result.headers });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}
```

`problemResponse` maps validation to 400, unauthenticated to 401, denied to 403, missing to 404, version conflict to 409, rate limit to 429 and unexpected errors to 500. The response never includes stack traces or secret inputs.

- [ ] **Step 5: Verify authentication flows and existing browser flows**

Run:

```powershell
pnpm vitest run test/server/auth-workflows.test.ts
pnpm test
pnpm typecheck
```

Expected: server tests PASS, existing 138 tests PASS, typecheck exits 0.

- [ ] **Step 6: Commit Task 5**

```powershell
git add server/modules/identity server/http app/api/auth test/server/auth-workflows.test.ts
git commit -m "feat: implement production authentication flows"
```

---

### Task 6: Server-side user administration

**Files:**
- Create: `server/modules/identity/user-repository.ts`
- Create: `server/modules/identity/user-service.ts`
- Create: `app/api/users/route.ts`
- Create: `app/api/users/[userId]/route.ts`
- Create: `app/api/users/[userId]/role/route.ts`
- Create: `app/api/users/[userId]/status/route.ts`
- Create: `test/server/user-administration-workflows.test.ts`

**Interfaces:**
- Consumes: authenticated `Actor`, `AdminUserView`, audit/outbox, `row_version`.
- Produces: `listUsers`, `createAdministrator`, `updateUserProfile`, `changeUserRole`, `changeUserStatus`.

- [ ] **Step 1: Write RED authorization and concurrency tests**

Required test matrix:

```ts
it.each([
  [null, 401],
  [memberActor, 403],
  [adminActor, 403],
])("denies user administration to %p", async (actor, status) => {
  expect((await callCreateAdministrator(actor)).status).toBe(status);
});

it("allows superadmin to create an invited admin with no readable password", async () => {
  const response = await callCreateAdministrator(superadminActor, validAdminInput);
  expect(response.status).toBe(201);
  expect(response.body.user.status).toBe("invited");
  expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|totpSecret/i);
});

it("rejects stale row_version and leaves the user unchanged", async () => {
  await expect(users.changeUserStatus(superadminActor, user.id, "blocked", 999))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
```

Add these exact authorization/invariant cases:

| Test name | Expected result |
|---|---|
| `cannot block the last active superadmin` | `LAST_ACTIVE_SUPERADMIN`, no row changes |
| `cannot demote the last active superadmin` | `LAST_ACTIVE_SUPERADMIN`, no row changes |
| `blocking a user revokes sessions and challenges atomically` | user blocked and all active credentials revoked in one commit |
| `role reduction revokes privileged sessions` | previous session no longer resolves |
| `admin with owned documents requires transfer before demotion` | `TRANSFER_REQUIRED` with owned-document count |
| `user mutation writes allowed or denied audit` | exactly one correctly classified event per request |

- [ ] **Step 2: Run the RED user workflow test**

Run: `pnpm vitest run test/server/user-administration-workflows.test.ts`

Expected: FAIL because the server user service and endpoints do not exist.

- [ ] **Step 3: Implement exact server commands**

```ts
export interface UserService {
  listUsers(actor: Actor, filters: UserFilters): Promise<AdminUserView[]>;
  createAdministrator(actor: Actor, input: CreateAdministratorInput, idempotencyKey: string): Promise<AdminUserView>;
  updateUserProfile(actor: Actor, userId: string, input: UpdateUserInput & VersionedCommand): Promise<AdminUserView>;
  changeUserRole(actor: Actor, userId: string, role: Role, command: VersionedCommand): Promise<AdminUserView>;
  changeUserStatus(actor: Actor, userId: string, status: UserStatus, command: VersionedCommand): Promise<AdminUserView>;
}
```

Only a superadmin may call these commands. `createAdministrator` accepts only `admin` or `superadmin`, creates an invited user and outbox password-setup notification, and is idempotent. Updates use `where id = $id and row_version = $expected`, increment `row_version`, and return `VERSION_CONFLICT` when no row matches. Every denial and success is audited.

- [ ] **Step 4: Implement the thin HTTP routes**

Use `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `POST /api/users/:id/role`, and `POST /api/users/:id/status`. Require `Idempotency-Key` for POST and `If-Match` containing the numeric row version for PATCH/change commands.

- [ ] **Step 5: Verify user workflows**

Run:

```powershell
pnpm vitest run test/server/user-administration-workflows.test.ts
pnpm test
pnpm typecheck
```

Expected: all commands enforce role, concurrency and last-superadmin safeguards; pilot suite remains green.

- [ ] **Step 6: Commit Task 6**

```powershell
git add server/modules/identity app/api/users test/server/user-administration-workflows.test.ts
git commit -m "feat: add server user administration"
```

---

### Task 7: Documents, ownership, numbering, and state transitions

**Files:**
- Create: `server/modules/documents/document-repository.ts`
- Create: `server/modules/documents/document-service.ts`
- Create: `server/modules/documents/document-state-machine.ts`
- Create: `app/api/documents/route.ts`
- Create: `app/api/documents/[documentId]/route.ts`
- Create: `app/api/documents/[documentId]/status/route.ts`
- Create: `app/api/documents/[documentId]/owner/route.ts`
- Create: `test/server/document-workflows.test.ts`
- Create: `server/db/migrations/0002_document_sequence.sql`

**Interfaces:**
- Consumes: `PublicDocumentSummary`, `DocumentAdminView`, `Actor`, `VersionedCommand`, audit and outbox.
- Produces: `listVisibleDocuments`, `createDocument`, `updateDocument`, `changeDocumentStatus`, `transferOwnership`.

- [ ] **Step 1: Add a concurrency-safe numbering sequence and write RED tests**

Create the new forward-only migration `0002_document_sequence.sql`; never edit an already applied migration:

```sql
create table document_sequences (
  year integer primary key check (year between 2020 and 2200),
  last_value integer not null check (last_value > 0)
);

alter table documents add column closure_reason text not null default '';

create table document_approvals (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete restrict,
  requested_by_user_id uuid not null references users(id) on delete restrict,
  requested_status document_status not null,
  requested_row_version integer not null,
  decided_by_user_id uuid references users(id) on delete restrict,
  decision text check (decision in ('approved', 'rejected')),
  reason text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  check ((decision is null and decided_at is null) or (decision is not null and decided_at is not null))
);

create unique index document_approvals_pending_idx
on document_approvals(document_id, requested_status)
where decision is null;
```

Required RED tests:

```ts
it("allocates unique sequential numbers under concurrent creation", async () => {
  const created = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    documents.createDocument(adminActor, {
      title: `Norma ${index}`,
      explanatoryReport: "Důvodová zpráva",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      idempotencyKey: crypto.randomUUID(),
    })
  ));
  expect(new Set(created.map((item) => item.number)).size).toBe(10);
});

it("prevents an admin from changing another admin's document", async () => {
  await expect(documents.updateDocument(otherAdminActor, owned.id, patch))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("allows only superadmin to transfer ownership", async () => {
  await expect(documents.transferOwnership(adminActor, owned.id, otherAdmin.id, command))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
});
```

Add these exact document cases:

| Test name | Expected result |
|---|---|
| `anonymous list shows only published public-detail documents` | concepts and login-required details are absent |
| `verified member can read login-required detail` | published detail returned without admin fields |
| `stale document update is rejected` | `VERSION_CONFLICT`, persisted title unchanged |
| `closing comments requires a reason` | blank reason returns `CLOSURE_REASON_REQUIRED` |
| `approved and rejected only transition to archived` | every other requested state returns `INVALID_TRANSITION` |
| `four-eyes publish creates pending approval` | state remains `ready`; pending approval row exists |
| `superadmin approval applies requested state once` | state becomes `published_open`; retry is idempotent |

- [ ] **Step 2: Run the RED document test**

Run: `pnpm vitest run test/server/document-workflows.test.ts`

Expected: FAIL because document modules and routes do not exist.

- [ ] **Step 3: Implement the state machine and document service**

`document-state-machine.ts` must contain an explicit transition map:

```ts
export const ALLOWED_DOCUMENT_TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  concept: ["file_check"],
  file_check: ["conversion"],
  conversion: ["conversion_review"],
  conversion_review: ["conversion", "ready"],
  ready: ["published_open"],
  published_open: ["comments_closed"],
  comments_closed: ["published_open", "settlement"],
  settlement: ["settled"],
  settled: ["approved", "rejected"],
  approved: ["archived"],
  rejected: ["archived"],
  archived: [],
};
```

The service interface is:

```ts
export interface DocumentService {
  listVisibleDocuments(actor: Actor | null): Promise<PublicDocumentSummary[]>;
  getManagedDocument(actor: Actor, documentId: string): Promise<DocumentAdminView>;
  createDocument(actor: Actor, input: CreateDocumentInput): Promise<DocumentAdminView>;
  updateDocument(actor: Actor, documentId: string, input: UpdateDocumentInput & VersionedCommand): Promise<DocumentAdminView>;
  changeDocumentStatus(actor: Actor, documentId: string, status: DocumentStatus, reason: string, command: VersionedCommand): Promise<DocumentAdminView>;
  transferOwnership(actor: Actor, documentId: string, ownerAdminId: string, command: VersionedCommand): Promise<DocumentAdminView>;
}
```

Number allocation must use one transaction with:

```sql
insert into document_sequences(year, last_value) values ($year, 1)
on conflict (year) do update set last_value = document_sequences.last_value + 1
returning last_value;
```

The admin ownership check and versioned update happen in SQL, not only before the query. Superadmin bypasses ownership but not `row_version`. Closing comments requires non-empty reason. Four-eyes documents create an approval requirement instead of immediately applying publish/final closure.

- [ ] **Step 4: Implement public and administrative routes**

Use `GET/POST /api/documents`, `GET/PATCH /api/documents/:id`, `POST /api/documents/:id/status`, and `POST /api/documents/:id/owner`. List/detail routes return only public-safe DTOs unless the authenticated actor may manage the document.

- [ ] **Step 5: Verify document workflows**

Run:

```powershell
pnpm vitest run test/server/document-workflows.test.ts
pnpm test
pnpm typecheck
```

Expected: concurrency, ownership, state and visibility tests PASS; existing norm workflows remain green.

- [ ] **Step 6: Commit Task 7**

```powershell
git add server/modules/documents app/api/documents server/db/migrations/0002_document_sequence.sql test/server/document-workflows.test.ts
git commit -m "feat: add server document workflows"
```

---

### Task 8: Server API client and incremental UI switch

**Files:**
- Create: `app/data/server-api-client.js`
- Create: `app/data/create-data-services.js`
- Create: `app/api/bootstrap/route.ts`
- Create: `test/server/server-api-client.test.js`
- Create: `test/server/bootstrap-redaction.test.ts`
- Modify: `app/hooks/use-app-controller.js`
- Modify: `app/page.js`
- Modify: `app/components/auth/DemoInbox.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `/api/bootstrap`, auth, users and documents routes from Tasks 5–7.
- Produces: an asynchronous service bundle consumed by `useAppController`, with `bootstrap()`, `auth`, `userService`, and `normService` methods matching existing controller intent.

- [ ] **Step 1: Write RED adapter and redaction tests**

Create `test/server/server-api-client.test.js`:

```js
it("sends cookies, CSRF and optimistic concurrency headers", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(updated), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });
  await client.normService.update("ignored-cookie-session", updated.id, {
    title: "Nový název",
    rowVersion: 3,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(fetchImpl).toHaveBeenCalledWith(`/api/documents/${updated.id}`, expect.objectContaining({
    credentials: "same-origin",
    headers: expect.objectContaining({ "if-match": "3", "x-csrf-token": "csrf" }),
  }));
});
```

Create `test/server/bootstrap-redaction.test.ts` to seed an anonymous, member, admin and superadmin request and assert that anonymous/member snapshots contain no e-mail, member ID, credential, session or internal audit fields.

Use exact-key assertions so the permitted self-view field `emailVerifiedAt` is not mistaken for the private `email` field:

```ts
expect(JSON.stringify(snapshot)).not.toMatch(/"(email|membershipId|ownerAdminId|rowVersion|passwordHash|tokenHash)"\s*:/i);
```

- [ ] **Step 2: Run RED adapter tests**

Run:

```powershell
pnpm vitest run test/server/server-api-client.test.js test/server/bootstrap-redaction.test.ts
```

Expected: FAIL because client and bootstrap endpoint do not exist.

- [ ] **Step 3: Implement the server client and backend selector**

`app/data/create-data-services.js` must use an explicit, build-time-safe selector:

```js
export function createDataServices({ env = process.env, browserFactory, serverFactory }) {
  if (env.NEXT_PUBLIC_DATA_BACKEND === "browser") return browserFactory();
  return serverFactory();
}
```

Production environment validation rejects `NEXT_PUBLIC_DATA_BACKEND=browser`. The demo build sets it explicitly. The API client uses same-origin cookies and never reads/writes a session identifier in `sessionStorage`.

The bootstrap endpoint returns:

```ts
{
  viewer: ViewerUser | null,
  documents: PublicDocumentSummary[],
  managedDocuments: DocumentAdminView[],
  organizations: { code: string; name: string }[],
  capabilities: {
    manageUsers: boolean,
    createDocument: boolean
  }
}
```

Admin-only data is fetched from `/api/users` only after opening user administration.

For anonymous users and members, `managedDocuments` is always empty. For an admin it contains only owned documents; for a superadmin it may contain all documents. `documents` never contains internal UUID, owner UUID or `rowVersion`.

- [ ] **Step 4: Refactor the controller to asynchronous bootstrap without rewriting UI components**

Replace synchronous `repository.read()` refresh with:

```js
const refresh = useCallback(async () => {
  const bundle = servicesRef.current;
  if (!bundle) return null;
  const snapshot = await bundle.bootstrap();
  setState((current) => ({ ...current, norms: snapshot.norms, organizations: snapshot.organizations }));
  setSession(snapshot.viewer ? { id: "server-cookie", user: snapshot.viewer } : null);
  return snapshot;
}, []);
```

The server client adapts the new DTOs to the existing UI shape at one boundary only:

```js
function adaptBootstrapForPilotUi(snapshot) {
  const allByPublicId = new Map(snapshot.documents.map((item) => [item.publicId, item]));
  for (const managed of snapshot.managedDocuments) {
    allByPublicId.set(managed.publicId, { ...allByPublicId.get(managed.publicId), ...managed });
  }
  return {
    viewer: snapshot.viewer,
    organizations: snapshot.organizations,
    norms: [...allByPublicId.values()].map((document) => {
      return {
        ...document,
        id: document.id || document.publicId,
        number: document.publicId,
        reason: document.explanatoryReport,
        content: [],
        submissions: [],
      };
    }),
  };
}
```

This is the only legacy mapping. Server modules never use the pilot names `norm`, `reason` or `submissions`.

All mutation callbacks await the remote service and then await `refresh()`. Browser mode keeps the existing service bundle behind an adapter that implements asynchronous `bootstrap()`. Remove production dependence on `SESSION_STORAGE_KEY`; retain it only inside the browser-demo adapter so existing fixtures continue to work.

`DemoInbox` renders only when `NEXT_PUBLIC_DATA_BACKEND === "browser"` and `NODE_ENV !== "production"`.

- [ ] **Step 5: Verify both backends and browser behavior**

Run:

```powershell
$env:NEXT_PUBLIC_DATA_BACKEND='browser'
pnpm test
pnpm build
$env:NEXT_PUBLIC_DATA_BACKEND='server'
pnpm vitest run test/server
pnpm typecheck
pnpm build:server
```

Expected: existing 138 tests PASS in browser mode; all server tests PASS; both builds exit 0.

- [ ] **Step 6: Commit Task 8**

```powershell
git add app/data app/api/bootstrap app/hooks/use-app-controller.js app/page.js app/components/auth/DemoInbox.js test/server .env.example
git commit -m "feat: connect existing ui to server api"
```

---

### Task 9: Production container gate, end-to-end acceptance, and operations handoff

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `scripts/smoke-server.mjs`
- Create: `docs/operations/local-server.md`
- Create: `docs/operations/phase-a-runbook.md`
- Create: `test/server/phase-a-acceptance.test.ts`
- Modify: `package.json`
- Modify: `next.config.cjs`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: all Phase A endpoints and the existing UI.
- Produces: reproducible standard Next container, complete Phase A verification command and operations handoff for the DOCX phase.

- [ ] **Step 1: Write the RED Phase A acceptance test**

Create one real-database scenario that performs these operations in order:

```ts
it("completes the approved phase A lifecycle", async () => {
  const superadmin = await loginAdminWithPasswordAndTotp(superadminCredentials);
  const invited = await createAdministrator(superadmin, newAdminInput);
  const admin = await completeAdminSetupWithMfa(invited);
  const document = await createDocument(admin, {
    title: "Návrh směrnice",
    explanatoryReport: "Důvodová zpráva",
    visibilityMode: "public_detail",
    fourEyesRequired: false,
  });
  await expect(updateDocument(otherAdmin, document.id, { title: "Cizí změna" }))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
  const publicSnapshot = await bootstrap(null);
  expect(publicSnapshot.documents[0].title).toBe("Návrh směrnice");
  expect(JSON.stringify(publicSnapshot)).not.toMatch(/"(email|membershipId|ownerAdminId|rowVersion)"\s*:/i);
  await transferOwnership(superadmin, document.id, otherAdmin.userId, document.rowVersion);
});
```

After the lifecycle actions, use these explicit assertions:

```ts
expect(await auditActions()).toEqual(expect.arrayContaining([
  "auth.admin_login", "user.created", "document.created",
  "authorization.denied", "document.owner_transferred",
]));
expect(JSON.stringify(await auditRows())).not.toMatch(/Correct-Horse|totp|sessionToken/i);
expect(await documentRowVersions(document.id)).toEqual([1, 2]);
expect(await resolves(oldBlockedUserSession)).toBe(false);
expect(await countOutboxByIdempotencyKey(retriedKey)).toBe(1);
```

- [ ] **Step 2: Run the RED acceptance test**

Run: `pnpm vitest run test/server/phase-a-acceptance.test.ts`

Expected: any missing integration fails visibly; do not weaken assertions to make it pass.

- [ ] **Step 3: Add the production container and health gate**

Set `output: "standalone"` in `next.config.cjs`. Use a multi-stage Node 22 Alpine Dockerfile. Build with `pnpm build:server`, copy the Next standalone output and run as a non-root user. Add `GET /api/health/live` with no dependencies and `GET /api/health/ready` that performs `select 1` with a two-second timeout. Health responses contain no environment or database details.

The smoke script must start the built container against PostgreSQL, poll readiness, execute anonymous bootstrap, member OTP in test-mail mode, admin password+MFA, admin creation, document creation, cross-owner denial and logout, then stop all processes and verify that its ports are released.

- [ ] **Step 4: Document exact local and operational commands**

`docs/operations/local-server.md` must contain:

```powershell
Copy-Item .env.example .env.local
pnpm install --frozen-lockfile
pnpm db:up
$env:DATABASE_URL='postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test'
pnpm db:migrate
pnpm dev:server
```

`phase-a-runbook.md` must document startup, migration, readiness, rollback boundary, session revocation, lost-MFA recovery by superadmin, audit verification and database backup/restore rehearsal. It must explicitly state that DOCX upload is not yet production-enabled.

- [ ] **Step 5: Run the full Phase A gate**

Run in a clean environment:

```powershell
pnpm install --frozen-lockfile
pnpm db:up
$env:DATABASE_URL='postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test'
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm build
pnpm build:server
node scripts/smoke-server.mjs
git diff --check
```

Expected evidence:

- existing pilot suite: 138/138 PASS;
- all `test/server` suites: PASS with zero failures;
- typecheck: exit 0;
- pilot and standard Next builds: exit 0;
- smoke script: all assertions PASS, no browser/resource errors, cleanup PASS;
- `git diff --check`: no output and exit 0.

- [ ] **Step 6: Request code review and address only verified findings**

Use `superpowers:requesting-code-review`. Reproduce each Important or Critical finding with a failing test before changing production code. Re-run the full Phase A gate after fixes.

- [ ] **Step 7: Commit Task 9**

```powershell
git add Dockerfile .dockerignore scripts/smoke-server.mjs docs/operations test/server package.json next.config.cjs README.md docs/ARCHITECTURE.md
git commit -m "chore: complete production foundation gate"
```

## Phase A completion checkpoint

Phase A is complete only when:

- browser demo remains deployable and all existing regression tests pass;
- server mode uses PostgreSQL and secure server cookies, not browser storage;
- member OTP and administrator password+MFA flows pass real-database tests;
- superadmin-only user administration and owner-scoped document administration are enforced in SQL-backed services;
- public bootstrap and document responses pass explicit privacy redaction tests;
- audit and outbox are transactionally coupled to mutations;
- container build, health checks, smoke scenario and cleanup pass;
- the worktree is clean and commits are small enough to review independently.

After this checkpoint, create the next plan for object storage, quarantine, antivirus, original DOCX archival, normalized AST, stable blocks and administrative conversion preview (architecture packages 5–7).
