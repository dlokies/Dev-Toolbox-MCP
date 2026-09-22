# Cloudflare Remote MCP OAuth: field guide

This document captures the reusable OAuth lessons from the Home Inventory MCP.
It is intended as a starting point for other private, stateless MCP servers on
Cloudflare Workers. The pattern was verified in production on 2026-09-21 with a
real Cloudflare Access login, MCP calls, and refresh-token rotation.

Always recheck the current Cloudflare and MCP documentation before copying the
package versions or provider options. The protocol and libraries are still
evolving.

## Working topology

Use three separate roles and keep their tokens separate:

1. The MCP client talks to the Worker as an OAuth client.
2. `@cloudflare/workers-oauth-provider` makes the Worker the MCP-facing
   authorization server and resource server.
3. Cloudflare Access for SaaS is the upstream OIDC provider that authenticates
   the human in the browser.

The Worker issues its own MCP access and refresh tokens. It must not return the
upstream Access token or ID token to the MCP client.

For a stateless MCP, use `createMcpHandler` from `agents/mcp/server` at `/mcp`.
Do not place a self-hosted Access application in front of the complete hostname
or `/mcp`: its HTML login redirect prevents the MCP client from receiving the
standard `401` and OAuth discovery metadata.

The public routes are normally:

- `/mcp`: protected Streamable HTTP MCP endpoint
- `/.well-known/oauth-protected-resource/mcp`: resource metadata
- `/.well-known/oauth-authorization-server`: authorization-server metadata
- `/authorize`: MCP authorization request and consent
- `/callback`: upstream Access OIDC callback
- `/token`: MCP token and refresh endpoint
- `/register`: dynamic client registration when compatibility requires it
- the revocation endpoint published by the provider library

The resource and issuer are different values:

```text
resource = https://mcp.example.com/mcp
issuer   = https://mcp.example.com
```

Generate every OAuth URL from a fixed, validated public base URL. Never derive
the issuer, callback, or audience from `Host`, `Forwarded`, or
`X-Forwarded-Host` request headers.

## Storage: KV for the provider, D1 for immediate browser transactions

The official OAuth provider library requires a Workers KV binding, commonly
named `OAUTH_KV`, for registered clients, grants, access tokens, and refresh
tokens. Keep that binding.

Do not automatically use the same KV namespace for custom consent, state, nonce,
or PKCE transactions. These values are written in one request and often read in
the immediately following request:

```text
GET /authorize
  -> store consent transaction
  -> render consent form

POST /authorize
  -> immediately read and consume consent transaction
  -> redirect to Access

GET /callback
  -> immediately read and consume OIDC transaction
```

Workers KV is eventually consistent. In production, the consent GET and POST
can execute in different locations, so an immediate KV read may not observe the
preceding write. The visible symptom is intermittent or repeatable:

```text
POST /authorize -> 400 Invalid or expired OAuth transaction.
```

Local tests usually miss this because the local KV implementation observes the
write immediately.

Use a small D1 table for these application-owned, short-lived transactions when
the application already has D1:

```sql
CREATE TABLE oauth_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('consent', 'oidc')),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  expires_at INTEGER NOT NULL
);
```

The stored consent payload needs only the parsed MCP OAuth request, a hash of a
CSRF token, a hash of a browser secret, and its creation time. The OIDC payload
needs the parsed MCP OAuth request, PKCE verifier, nonce, browser-secret hash,
and creation time.

For each transaction:

- Generate an opaque random ID and store the payload under that ID.
- Return a signed `id.signature` reference; use HMAC-SHA-256 with a Worker secret.
- Bind it to the browser with a random secret in a `Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/` cookie whose name uses the `__Host-` prefix.
- Hash browser and CSRF secrets before storing them.
- Enforce a short lifetime, such as ten minutes, both in the row and in code.
- Delete the row when consumed and periodically remove expired rows during a
  related write. A cron job is unnecessary for a small service.
- Compare hashes and signatures without an early-exit string comparison.
- Fail closed with `503` if D1 is unavailable; never continue without state
  validation.

Deletion is useful replay protection, but do not treat it as the only one-time
guarantee. The upstream authorization code and PKCE verifier are also single-use.
For a high-volume or multi-user service, reassess the transaction-consumption
primitive and replay model instead of copying this small-service design.

## CSP can block the form redirect to Access

A strict consent-page policy initially used:

```text
form-action 'self'
```

The consent form posts to the Worker's own `/authorize`, which then returns a
`302` to the Cloudflare Access authorization endpoint. Browsers may enforce
`form-action` across that redirect chain. The POST succeeds, but navigation is
blocked and the user observes that the Authorize button does nothing. Chromium
reports a blocked form navigation in the console or Network panel.

Use both parts of this fix:

1. On the HTML consent response, allow only the Worker's own origin and the
   exact, validated Access origin:

   ```text
   default-src 'none';
   style-src 'unsafe-inline';
   form-action 'self' https://YOUR-TEAM.cloudflareaccess.com;
   base-uri 'none';
   frame-ancestors 'none'
   ```

2. Do not attach that document CSP to the empty `302` response that performs the
   cross-origin redirect. Keep `Cache-Control: no-store`, `Referrer-Policy:
no-referrer`, and `X-Content-Type-Options: nosniff` on the redirect.

Build the allowed Access origin from the already validated authorization URL.
Require HTTPS, no URL credentials, a `cloudflareaccess.com` hostname, and the
same expected Access host for authorization, token, JWKS, and issuer values. Do
not use a wildcard or accept an origin from request input.

## Access for SaaS configuration

Create one Access application with these properties:

- application type `saas`, protocol OIDC
- exact callback `https://mcp.example.com/callback`
- authorization code with PKCE
- OIDC scopes `openid email`
- only the intended identity provider
- an Allow policy for the exact owner identity

Read the issuer and endpoints from the application-specific OIDC discovery
document. Do not assemble paths from memory; the issuer can include the SaaS
client identifier.

The Worker configuration is split as follows:

| Value                      | Storage                                   |
| -------------------------- | ----------------------------------------- |
| `PUBLIC_BASE_URL`          | normal Worker variable                    |
| `ACCESS_CLIENT_ID`         | normal Worker variable                    |
| `ACCESS_AUTHORIZATION_URL` | normal Worker variable                    |
| `ACCESS_TOKEN_URL`         | normal Worker variable                    |
| `ACCESS_JWKS_URL`          | normal Worker variable                    |
| `ACCESS_ISSUER`            | normal Worker variable                    |
| `ACCESS_CLIENT_SECRET`     | Worker secret                             |
| `COOKIE_ENCRYPTION_KEY`    | Worker secret, at least 32 random bytes   |
| `OWNER_EMAIL`              | Worker secret for a second identity check |

Cloudflare may return the Access client secret only when the SaaS application is
created. Store it immediately as a Worker secret without printing it, committing
it, or copying it into a GitHub build variable.

Validate the upstream ID token with a maintained JOSE library. Check at least:

- signature against the configured JWKS
- an explicit algorithm allowlist
- exact issuer
- Access client ID as audience
- expiry and issued-at timing
- required `sub`, `email`, and `nonce` claims
- constant-time nonce comparison
- normalized email equality with the configured owner

Create MCP grant properties from the verified identity. Store only the data
needed for later authorization, such as subject, normalized email, permissions,
login time, and maximum login expiry. Do not retain upstream tokens in the grant.
Recheck owner, scope, and maximum login lifetime during refresh.

## Provider configuration that should be explicit

For a private MCP with authorization code and PKCE:

- disable the implicit flow
- reject plain PKCE; require S256
- disable token exchange unless there is a concrete use case
- declare the exact supported scope
- publish protected-resource metadata for the exact `/mcp` resource
- enable client-ID metadata documents when required by current MCP clients
- keep DCR only when client compatibility requires it
- set bounded access-token, refresh-token, and client-registration lifetimes
- validate grant properties again in the provider's token/refresh callback

When client-ID metadata documents are enabled on Workers, the current Cloudflare
pattern uses the `global_fetch_strictly_public` compatibility flag. Verify this
against the current provider documentation before each new project.

The OAuth provider injects an `OAUTH_PROVIDER` helper into the authorization
handler. It is not a separate Cloudflare resource. The KV namespace remains a
normal binding named `OAUTH_KV`.

## Host, origin, and alternate routes

Configure host and browser-origin protection through the native options of the
current `createMcpHandler`:

- allow only the production hostname
- keep originless server-side MCP clients working
- add browser origins only when a real browser client requires one
- do not add a second custom origin middleware or a wildcard

Disable `workers.dev` and preview URLs when the custom domain is the only intended
entry point. Confirm that the alternate Worker URL cannot expose the MCP.

## Debugging the two production failures

Use a fresh OAuth attempt for each test. Reusing an old `/authorize` URL can
correctly fail because its client state, local callback listener, or ten-minute
transaction has expired.

For `400 Invalid or expired OAuth transaction` on `POST /authorize`:

1. Confirm the GET rendered a new form and set the consent cookie.
2. Confirm the POST contains that cookie, transaction reference, and CSRF value.
3. Tail the Worker and verify the GET and POST both reached the expected version.
4. Check whether custom state was stored in KV immediately before being read.
5. Move only the immediate read-after-write transaction state to D1; leave the
   provider's own `OAUTH_KV` binding intact.
6. Apply the D1 migration before deploying the code.

For an Authorize button that appears to do nothing:

1. Inspect the POST in the browser Network panel.
2. If it returns `302`, inspect the console for a CSP `form-action` violation.
3. Verify the response redirects to the exact Access authorization origin.
4. Add that validated origin to the consent document's `form-action` directive.
5. Remove the document CSP from the empty redirect response.

Worker tail output is useful to distinguish an application `400` from a browser
that blocks a successful `302`. Do not log authorization headers, cookies,
form bodies, callback query strings, codes, state, nonce, PKCE values, tokens, or
ID-token claims while debugging.

## Tests that catch application integration errors

Test the integration code, not a home-grown reimplementation of the OAuth
provider's conformance suite.

Local Workers-runtime tests should cover:

- exact issuer, resource, and endpoints in both discovery documents
- unauthenticated `/mcp` returns `401` before a tool executes
- consent GET stores state and sets the expected secure cookie
- consent POST can immediately consume that state
- consent CSP contains the exact upstream Access origin
- redirect responses do not contain the blocking document CSP
- state, browser binding, CSRF, nonce, issuer, audience, and owner failures
- upstream token or JWKS failure grants no MCP authorization
- MCP tokens never contain or expose the upstream token
- refresh rechecks owner, scope, and maximum login lifetime
- missing configuration and D1/KV failures fail closed
- a successful local flow reaches an authenticated MCP tool

The final remote smoke test must use the real domain and real Access login:

1. Request `/mcp` without a token and verify `401` plus `WWW-Authenticate`.
2. Load both discovery documents.
3. Register or identify a client and start authorization code with PKCE S256.
4. Approve consent and complete the real Access login and MFA.
5. Exchange the MCP code and call `tools/list`.
6. Execute at least one authenticated tool.
7. Refresh the token and call the MCP again.

A local green test cannot prove KV visibility, browser CSP navigation, Access
policy, callback configuration, DNS, TLS, or the deployed secrets.

## Deployment checklist

Use this order for a new project:

1. Fix the canonical domain, issuer, resource, callback, and scope names.
2. Create D1 and the provider KV namespace; add both bindings.
3. Apply the D1 migrations, including `oauth_transactions`.
4. Deploy a fail-closed Worker before exposing the custom domain.
5. Create the owner-only Access policy and the Access for SaaS OIDC app.
6. Store the returned Access client secret and other secret values as Worker
   secrets.
7. Read and validate the application-specific OIDC discovery values.
8. Add the custom domain and keep alternate Worker URLs disabled.
9. Run the complete real OAuth and MCP smoke test.
10. Connect native Workers Builds only after the runtime secrets already exist on
    the Worker. The GitHub repository does not need those runtime secret values.

For schema changes, apply remote D1 migrations before the Worker deployment that
depends on them. A Git push cannot safely make that ordering decision by itself
unless the build pipeline explicitly includes a reviewed migration step.

## Reference implementation in this repository

The reusable pieces are:

- [`src/index.ts`](../src/index.ts): provider configuration and token/refresh
  authorization checks
- [`src/auth-handler.ts`](../src/auth-handler.ts): consent, Access redirect, and
  callback routing
- [`src/oauth-utils.ts`](../src/oauth-utils.ts): D1 transactions, browser binding,
  PKCE, state, and ID-token verification
- [`migrations/0002_create_oauth_transactions.sql`](../migrations/0002_create_oauth_transactions.sql):
  transaction table
- [`test/oauth.spec.ts`](../test/oauth.spec.ts): integration-focused test flow
- [`scripts/remote-smoke.ts`](../scripts/remote-smoke.ts): real remote acceptance
  test

The implementation uses package versions locked in this repository. Treat them
as a known working set for this date, not as permanent recommendations.

## Primary documentation

- [Cloudflare remote MCP server guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Cloudflare Access for MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [Generic OIDC SaaS application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/)
- [Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
