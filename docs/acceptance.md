# V1 acceptance evidence

Accepted on 2026-09-22 against `https://dev.domenic.dev/mcp`.

## Application and deployment evidence

Application commit: `3d9e3b7a24bec87bc6af387c2161e361e068b91e`.

| Run                                    | Trigger and result                                                            | Worker version                         |
| -------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| `420e5161-1a67-4b9e-a42b-c770900b11dd` | Actual GitHub `main` push (`push_event`), success at 07:47:23 UTC             | `d49f9caf-57d2-42aa-9b08-8f0dc370d390` |
| `ac49b22a-b971-48b8-a5e2-6c0ccc9b9fd0` | Same commit, explicit repeat through the same Workers Builds trigger, success | `0df95497-89ce-4d7f-ab10-00e0ad385fd8` |

The deployed version was independently read through the Workers deployments API and matched each build's logged version. Both builds ran the frozen install, formatting, TypeScript, all 23 Workers tests, migration failure/rollback/retry/no-op checks, dry-run, remote migrations and deployment. Remote migrations reported `No migrations to apply!`. The repeat deployment finished at 07:56:56 UTC while the three smoke fixtures remained in D1.

This document records the tested application snapshot. A later documentation-only push produces its own production version through the same pipeline without changing that application snapshot.

## Provisioned resources

| Resource                           | Identifier                                                        |
| ---------------------------------- | ----------------------------------------------------------------- |
| Worker / tag                       | `dev-toolbox-mcp` / `e62dedde289d49868e54679bb76d674e`            |
| D1                                 | `dev-toolbox` / `a444b18c-6b05-4b3d-950b-5fd47f6d6ce1`            |
| KV                                 | `dev-toolbox-mcp-oauth` / `6955c33a0b3c40aca5d4e4c69ed6fa9a`      |
| Access SaaS/OIDC application       | `a56bbc0f-7da5-410b-abc2-80bdda080a74`                            |
| Dedicated owner policy             | `b9dce026-0c14-438a-8483-602841f88b83`                            |
| Worker custom domain               | `e9925b6070f186635e828ec383e0c516b35bc9ff`                        |
| GitHub repository connection       | `3205e0f3-3b17-4f19-9085-3caeb57afd46`                            |
| Production build trigger           | `ffa63a24-de14-47cb-a11c-699ffda9cd72`                            |
| Existing user-provided build token | `dev-toolboc-mcp-builds` / `abe25061-67da-4e69-ad72-0c3fc0668ea7` |

Control-plane provisioning used `cloudflare-mcp`. The official Wrangler mechanism applied `0001_create_defaults.sql` and `0002_create_oauth_transactions.sql`; both were verified in `d1_migrations`. No custom migration engine or local application deployment was used.

Bootstrap ordering refinement: the MCP API created a closed `503` Worker to accept bindings/secrets and the native Builds link. The first `main` build supplied the application bundle, then real OAuth acceptance ran. This avoided transferring a 1.4 MiB compiled bundle through the MCP tool and kept application deployment in the GitHub pipeline from its first version.

Live configuration confirmed:

- One SaaS/OIDC application using the existing Cloudflare IdP, exactly one owner email allow rule, no bypass rule, and only the canonical callback.
- Authorization Code with PKCE, upstream scopes `openid email`, and app-specific issuer/endpoints obtained from actual discovery.
- No self-hosted Access application covering the MCP host.
- `ACCESS_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` and `OWNER_EMAIL` present as Worker secrets after deployment. Secret values were not placed in files or Git.
- GitHub repository `dlokies/Dev-Toolbox-MCP`, production branch `main`, all paths, one trigger and `previews_enabled=false`.
- `workers.dev` and preview URLs disabled. An actual request to `https://dev-toolbox-mcp.domenic-lokies.workers.dev/mcp` returned `404`.
- No paid plan, trial or add-on activated; no billing endpoints inspected. No changes to Home Inventory or Decision Log resources.

## Local and remote verification

Local `pnpm run check` and `pnpm run build:check` passed with the final bindings and OAuth configuration. The maintained OAuth field guide has no changes relative to the original repository commit `1b9d651`.

`pnpm run smoke:remote --wait-for-builds` exited successfully. Verified:

- Public canonical discovery; unauthenticated `401`, correct `WWW-Authenticate` resource/scope and `Cache-Control: no-store`.
- Actual browser consent, Access authentication, callback, PKCE exchange, authenticated MCP calls and rotated refresh/access tokens.
- Exact server Description and Instructions in current discovery and supported legacy initialization; exactly four tools with input/output schemas and annotations.
- Valid create and full replacement update; both half-paired identification variants rejected at the tool boundary.
- `topic_mode=any/all`, independent inclusion of general defaults, and proof that general entries cannot bypass a nonmatching text query.
- Full applicability conditions, pagination, stable IDs across preference changes, `unchanged`, stale revision conflicts and deletion conflict protection.
- Identical updated preference and all three fixture IDs after the repeat build; migrations did not reset application data.
- Policy block on successful tool responses and identical structured/JSON-text content.
- Invalid bearer token rejection, precise delete confirmations, cleanup and published refresh-token revocation.

The Chrome DevTools-controlled session encountered Cloudflare's browser-verification failure. The same legitimate OAuth flow succeeded through the user's existing regular Chrome profile using native Chrome UI control. Existing browser identity was reused; no authentication or anti-automation protection was disabled.

## Fixtures and cleanup

Marker: `toolbox-smoke-1790063283527-75f2035ef916`.

| Fixture                 | ID                                     |
| ----------------------- | -------------------------------------- |
| General                 | `0faf2453-9de2-4f57-9cac-151ef211347f` |
| Java / Spring / Testing | `064b10df-cf19-48d9-91ce-5ce90904c04b` |
| Review / Testing        | `8ed3fc62-c443-456f-b655-707027e904e2` |

All records explicitly limited applicability to this test. After persistence verification, the script read each current revision, checked ownership markers and deleted it through `delete_default`. Each response matched the actual ID, title and deleted revision. Every ID then returned `NOT_FOUND`, marker search was empty and cleanup reported `remaining: []`. The refresh token was revoked and the script reported `remote-smoke-passed`. No real personal preferences were seeded.

## Verification limits

- No second human identity was available for a live negative login. Wrong-owner rejection is covered by local OIDC integration tests and the live exact-owner policy was inspected.
- Server tests demonstrate the contract and fixed precedence metadata, not every model's adherence or actual user intent. A local field-injection instruction takes precedence over a personal constructor-injection default and does not mutate that default.
- Pagination is not a snapshot during concurrent writes. There is intentionally no history or restore after explicit hard delete.
