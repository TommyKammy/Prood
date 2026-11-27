# Prood Architecture Decisions (PR 01)

## 1. Toolchain & Monorepo Structure
- **Package Manager**: `pnpm` workspaces (`@prood/*` scope), Node.js >= 22, native ESM (`"type": "module"`).
- **TypeScript**: Project references (`tsc -b`) with `strict: true` and `verbatimModuleSyntax: true`.
- **Testing**: Vitest separated into `unit` (no DB) and `db-contracts` (`PROOD_TEST_DB=sqlite|postgres`).

## 2. HTTP Layer & Cloudflare Portability
- **HTTP Framework**: **Hono** (`Web Standard Request/Response`).
- **Portability Boundary**:
  - `packages/domain` has zero runtime dependencies and uses relative imports only.
  - `packages/contracts`, `packages/application`, `packages/persistence/common`, and `apps/server/src/app.ts` forbid `node:*` and DB driver imports so the application core and HTTP router can be deployed to **Cloudflare Workers** with a future D1 / Hyperdrive adapter.
  - Node-specific startup (`@hono/node-server`) is isolated in `apps/server/src/index.ts`.

## 3. Identifiers & Localization
- **Public Task ID**: Immutable, required `id` field across both general and development projects (`tsk_<26-char lowercase Crockford Base32>`, generator finalized in PR 02). Development issue keys (e.g., `PRD-42`) use a mutually exclusive format.
- **Localization**: Default locale `en` with message catalog lookup, `Intl` formatting (dates, numbers, plural rules), and automatic fallback to `en` for missing keys or unknown locales.

## 4. Authentication & Identity Decisions (PR 03)
- **Authentication Library**: `better-auth` (`^1.7.28`) isolated inside `@prood/integration-better-auth`, sharing Prood's existing Kysely instance (`database: { db, type: "sqlite" | "postgres" }`) so auth and domain data live in the same selected DB.
- **Initial Login Flow**: Email + Password (`emailAndPassword: { enabled: true }`). OIDC SSO (test IdP) is deferred to a later phase.
- **Identity & Table Separation**: Better Auth manages `auth_user`, `auth_session`, `auth_account`, and `auth_verification`; Prood owns `users` (`usr_*`), `auth_identities` (`(auth_provider, auth_subject) -> user_id`), and `workspace_memberships` (`mbr_*`). Auth routes are mounted via Web-Standard `Request/Response` in `apps/server/src/app.ts` without importing `better-auth` into `app.ts`.
- **MCP OAuth Integration (PR 04)**: `@better-auth/oauth-provider` (`^1.7.28`) + `jwt()` acts as the OAuth 2.1 / OIDC issuer, while `fastmcp` (`^4.30.0`, `FastMCP` + `WebStreamableHTTPServerTransport` from `fastmcp/edge`) serves `/mcp` over Web-Standard HTTP with `jose` JWKS verification (`issuer`, `audience`, `exp`) and per-tool `prood:read` scope checks. See `docs/mcp-oauth-interop.md`.

## 5. Persistence & Public ID Decisions (PR 02)
- **Public ID Format**: `<prefix>_<26 lowercase Crockford Base32 ULID chars>` (48-bit Unix ms + 80-bit random, monotonic within the same millisecond). Implemented with zero runtime dependencies in `@prood/domain`, using Web Standard `crypto.getRandomValues` in `@prood/application`.
- **Persistence Stack**:
  - `kysely` (`^0.29.9`) for query building and transaction-scoped repositories inside `@prood/persistence-common`, keeping Kysely types out of `@prood/domain`, `@prood/contracts`, and `@prood/application`.
  - `better-sqlite3` (`^13.2.0`) for SQLite with per-connection `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout`, `BEGIN IMMEDIATE` transactions, and bounded retry on `SQLITE_BUSY` / `SQLITE_LOCKED`.
  - `pg` (`^8.23.1`) for PostgreSQL with `SET LOCAL lock_timeout` / `SET LOCAL statement_timeout` per transaction and bounded retry on `40001` / `40P01` / `55P03` / `57014`.
- **Error Boundary**: Driver errors map to `PersistenceError` (`UNIQUE_VIOLATION`, `FOREIGN_KEY_VIOLATION`, `NOT_NULL_VIOLATION`, `CHECK_VIOLATION`, `TRANSIENT_CONFLICT`, `CONNECTION_ERROR`, `UNKNOWN_DB_ERROR`); application/business errors thrown inside `UnitOfWork.run` roll back the transaction and pass through untouched.

