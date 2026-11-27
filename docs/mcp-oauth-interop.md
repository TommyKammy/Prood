# MCP OAuth 2.1 Interoperability Record (PR 04)

## 1. Selected Package Versions
- `better-auth`: `^1.7.28`
- `@better-auth/oauth-provider`: `^1.7.28`
- `fastmcp`: `^4.30.0`
- `@modelcontextprotocol/sdk`: `^1.32.2`
- `jose`: `^6.x`
- `zod`: `^4.1.13`

## 2. Authorization Server & Resource Server Configuration
- **Issuer**: `${baseURL}/api/auth` (`jwt({ disableSettingJwtHeader: true })` + `oauthProvider(...)`)
- **MCP Protected Resource**: `${baseURL}/mcp`
- **Discovery Endpoints**:
  - `GET /.well-known/oauth-protected-resource` (RFC 9728)
  - `GET /.well-known/oauth-authorization-server` (RFC 8414)
- **Dynamic Client Registration**: Enabled (`allowDynamicClientRegistration: true`, `allowUnauthenticatedClientRegistration: true`, PKCE `S256` enforced by Better Auth).
- **Scopes**: `openid`, `profile`, `email`, `prood:read`, `prood:write` (`whoami` requires `prood:read`).

## 3. Token Verification & Rejection Guarantees
- Every request to `/mcp` verifies `Authorization: Bearer <jwt>` against Better Auth's local JWKS (`createLocalJWKSet`) with strict `issuer`, `audience === mcpResource`, and `exp` checks.
- Missing / invalid / expired / wrong-audience tokens fail with HTTP `401` and `WWW-Authenticate: Bearer resource_metadata="..."`.
- Valid tokens lacking `prood:read` fail before `whoami` executes with HTTP `403 insufficient_scope`.
- Verified MCP calls resolve `sub` -> `users` (`usr_*`) through the shared `createMcpIdentityUseCase`, returning the exact same Prood user ID as Web `GET /api/v1/me` across both SQLite and PostgreSQL.
