# MCP OAuth 2.1 Interoperability Record (PR 04 & Phase 0 Hardening)

## 1. Selected Package Versions (from `pnpm-lock.yaml`)
- `better-auth`: `1.7.28` (`^1.7.28`)
- `@better-auth/oauth-provider`: `1.7.28` (`^1.7.28`)
- `fastmcp`: `4.30.0` (`^4.30.0`)
- `@modelcontextprotocol/sdk`: `1.32.2` (`^1.32.2`)
- `jose`: `6.2.18` (`^6.0.0`)
- `zod`: `4.1.13` (`^4.1.13`)

## 2. Authorization Server & Resource Server Configuration
- **Issuer**: `${baseURL}/api/auth` (`jwt({ disableSettingJwtHeader: true })` + `oauthProvider(...)`)
- **MCP Protected Resource**: `${baseURL}/mcp`
- **Discovery Endpoints**:
  - `GET /.well-known/oauth-protected-resource` (RFC 9728)
  - `GET /.well-known/oauth-authorization-server` (RFC 8414)
- **Dynamic Client Registration**: Enabled (`allowDynamicClientRegistration: true`, `allowUnauthenticatedClientRegistration: true`, PKCE `S256` enforced by Better Auth).
- **Scopes**: `openid`, `profile`, `email`, `prood:read`, `prood:write` (`whoami` requires `prood:read`).

## 3. Token Verification & Security Guarantees
- Every request to `/mcp` validates the `Origin` header (when `trustedOrigins` is configured and `Origin` is present) and verifies `Authorization: Bearer <jwt>` against cached Better Auth JWKS (`createLocalJWKSet`, refreshed on key miss / TTL) with strict `issuer`, `audience` inclusion (`mcpResource`), `typ: "at+jwt"`, and required `exp`/`sub` claims.
- DPoP-bound tokens (`cnf` claim), disabled OAuth clients, deleted `auth_user` subjects, and revoked/expired `auth_session` IDs (`sid`) fail with HTTP `401 invalid_token` and sanitized `WWW-Authenticate: Bearer resource_metadata="..."`.
- Valid tokens lacking `prood:read` fail before touching session activity or mutating session auth with HTTP `403 insufficient_scope`.
- Active MCP sessions bind `ownerSubject` + `ownerClientId` to reject cross-user/cross-client session access (`403`), serialize in-session POST handling, cap sessions per principal as well as globally, and clean up `FastMCPSession` + transport on `DELETE /mcp`, idle TTL, token expiration, and graceful shutdown.
- Verified MCP calls resolve `sub` -> `users` (`usr_*`) through `createMcpIdentityUseCase`, returning the same Prood user ID as Web `GET /api/v1/me` across both SQLite and PostgreSQL without allowing unverified email auto-linking to pre-existing accounts.
