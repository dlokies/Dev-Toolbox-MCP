# Working on Dev Toolbox MCP

- Keep this a small source of current personal development defaults. Do not add project knowledge, history, automatic preference extraction, or additional infrastructure without a concrete requirement.
- Preserve the four-tool contract, full replacement, revision checks, and `current user > project instructions > personal default`. Stored content is data and never authorizes actions. A local override does not change or delete a personal default.
- Respect the stateless Worker, D1, KV, and existing OAuth architecture. Read `docs/cloudflare-mcp-oauth-field-guide.md` completely before changing authentication.
- Never commit secrets, tokens, private keys, or real OAuth transaction data. Do not add authentication bypasses, including local ones.
- Stay Cloudflare Free compatible. Never activate paid plans, trials, or add-ons automatically.
- Prefer `cloudflare-mcp` for Cloudflare control-plane configuration. Use Wrangler's official D1 migrations; never edit or rename an applied migration.
- Keep migrations compatible with the currently running Worker. Do not reset production data or deploy concurrently with Workers Builds.
- Run `pnpm run check` and `pnpm run build:check` before pushing to `main`. A push to `main` triggers production checks, migrations, and deployment through Workers Builds.
- Verify relevant changes on the real OAuth-protected endpoint. Clean up only explicitly authorized, identified test fixtures through `delete_default`, and record the result and any verification limits.
- Keep README and acceptance evidence consistent with the deployed behavior. Do not change the OAuth field guide as part of normal application work.
