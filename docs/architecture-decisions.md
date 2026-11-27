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

## 4. Authentication Scope (PR 03 Preview)
- Initial Web login uses Better Auth **Email + Password**. OIDC SSO (test IdP) is deferred to a later phase.
