import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import type { AuthProps, Env } from "./env";
import {
  PublicOAuthError,
  clearOauthCookies,
  consumeConsentTransaction,
  consumeOidcTransaction,
  createConsentTransaction,
  createOidcRedirect,
  escapeHtml,
  exchangeAccessCode,
  readAuthConfiguration,
  stableUserId,
  verifyAccessIdToken,
} from "./oauth-utils";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function securityHeaders(
  headers?: HeadersInit,
  formAction = "'self'",
): Headers {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  );
  result.set("Referrer-Policy", "no-referrer");
  result.set("X-Content-Type-Options", "nosniff");
  return result;
}

function response(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: location,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function validateRequestedScopes(request: AuthRequest): void {
  if (request.scope.some((scope) => scope !== "toolbox")) {
    throw new PublicOAuthError(
      400,
      "The client requested an unsupported scope.",
    );
  }
}

function clientDisplayName(client: ClientInfo): string {
  return client.clientName?.trim() || "MCP client";
}

function renderConsent(
  client: ClientInfo,
  transaction: string,
  csrf: string,
  setCookie: string,
  accessOrigin: string,
): Response {
  const name = escapeHtml(clientDisplayName(client));
  const callback = escapeHtml(client.redirectUris.join(", "));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Dev Toolbox</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 38rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #17202a; }
    main { border: 1px solid #d5d8dc; border-radius: .75rem; padding: 1.5rem; }
    code { overflow-wrap: anywhere; }
    button { font: inherit; padding: .7rem 1rem; border: 0; border-radius: .4rem; cursor: pointer; }
    .approve { background: #1769aa; color: white; }
    .deny { background: #e5e7e9; margin-right: .5rem; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Dev Toolbox</h1>
    <p><strong>${name}</strong> requests full read and write access to your private development toolbox.</p>
    <p>Callback: <code>${callback}</code></p>
    <form method="post" action="/authorize">
      <input type="hidden" name="transaction" value="${escapeHtml(transaction)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
      <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
    </form>
  </main>
</body>
</html>`;
  const headers = securityHeaders(
    { "Content-Type": "text/html; charset=utf-8" },
    `'self' ${accessOrigin}`,
  );
  headers.append("Set-Cookie", setCookie);
  return new Response(html, { status: 200, headers });
}

async function handleAuthorizeGet(
  request: Request,
  env: Env,
): Promise<Response> {
  const config = readAuthConfiguration(env);
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  validateRequestedScopes(oauthRequest);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) throw new PublicOAuthError(400, "Unknown OAuth client.");
  const consent = await createConsentTransaction(env, config, oauthRequest);
  return renderConsent(
    client,
    consent.transaction,
    consent.csrf,
    consent.setCookie,
    config.authorizationUrl.origin,
  );
}

async function handleAuthorizePost(
  request: Request,
  env: Env,
): Promise<Response> {
  const config = readAuthConfiguration(env);
  const form = await request.formData();
  const transaction = form.get("transaction");
  const csrf = form.get("csrf");
  const decision = form.get("decision");
  if (typeof transaction !== "string" || typeof csrf !== "string") {
    throw new PublicOAuthError(400, "Invalid authorization form.");
  }
  const oauthRequest = await consumeConsentTransaction(
    request,
    env,
    config,
    transaction,
    csrf,
  );
  validateRequestedScopes(oauthRequest);
  if (decision !== "approve") {
    return response("Authorization was cancelled.", 403);
  }
  const upstream = await createOidcRedirect(env, config, oauthRequest);
  return redirect(upstream.location, [upstream.setCookie]);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const config = readAuthConfiguration(env);
  const url = new URL(request.url);
  if (url.searchParams.has("error")) {
    throw new PublicOAuthError(
      401,
      "Cloudflare Access login was not completed.",
    );
  }
  const code = url.searchParams.get("code");
  if (!code) throw new PublicOAuthError(400, "Missing authorization code.");

  const transaction = await consumeOidcTransaction(request, env, config);
  const idToken = await exchangeAccessCode(
    code,
    transaction.codeVerifier,
    config,
  );
  const claims = await verifyAccessIdToken(idToken, transaction.nonce, config);
  const authenticatedAt = Date.now();
  const props: AuthProps = {
    email: claims.email.normalize("NFKC").trim().toLowerCase(),
    subject: claims.sub,
    permissions: ["toolbox"],
    authenticatedAt,
    loginExpiresAt: authenticatedAt + WEEK_MS,
  };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: transaction.oauthRequest,
    userId: await stableUserId(config.issuer, claims.sub),
    metadata: { label: props.email },
    scope: ["toolbox"],
    props,
  });
  return redirect(redirectTo, clearOauthCookies());
}

export const authHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "GET" && pathname === "/authorize") {
        return await handleAuthorizeGet(request, env);
      }
      if (request.method === "POST" && pathname === "/authorize") {
        return await handleAuthorizePost(request, env);
      }
      if (request.method === "GET" && pathname === "/callback") {
        return await handleCallback(request, env);
      }
      return response("Not Found", 404);
    } catch (error) {
      if (error instanceof PublicOAuthError)
        return response(error.message, error.status);
      if (error instanceof AuthorizationError) {
        if (error.redirectUri) {
          const destination = new URL(error.redirectUri);
          destination.searchParams.set("error", error.code);
          destination.searchParams.set("error_description", error.description);
          if (error.state) destination.searchParams.set("state", error.state);
          if (error.issuer) destination.searchParams.set("iss", error.issuer);
          return redirect(destination.href);
        }
        return response(error.description, 400);
      }
      return response("Authentication request failed.", 500);
    }
  },
};
