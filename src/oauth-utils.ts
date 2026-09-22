import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";

const encoder = new TextEncoder();
const CONSENT_COOKIE = "__Host-DEVTOOLBOX_CONSENT";
const OIDC_COOKIE = "__Host-DEVTOOLBOX_OIDC";
const TRANSACTION_TTL_SECONDS = 600;

type TransactionKind = "consent" | "oidc";

interface TransactionRow {
  payload_json: string;
  expires_at: number;
}

export interface AccessClaims extends JWTPayload {
  email: string;
  sub: string;
  nonce: string;
}

interface ConsentTransaction {
  oauthRequest: AuthRequest;
  csrfHash: string;
  browserHash: string;
  createdAt: number;
}

interface OidcTransaction {
  oauthRequest: AuthRequest;
  codeVerifier: string;
  nonce: string;
  browserHash: string;
  createdAt: number;
}

export class PublicOAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublicOAuthError";
  }
}

export interface AuthConfiguration {
  baseUrl: URL;
  clientId: string;
  clientSecret: string;
  authorizationUrl: URL;
  tokenUrl: URL;
  jwksUrl: URL;
  issuer: string;
  cookieKey: string;
  ownerEmail: string;
}

function configured(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new PublicOAuthError(
      503,
      `Authentication configuration ${name} is missing.`,
    );
  }
  return value.trim();
}

function accessUrl(value: string, name: string, expectedHost?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicOAuthError(
      503,
      `Authentication configuration ${name} is invalid.`,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.hostname.endsWith(".cloudflareaccess.com") ||
    (expectedHost && url.hostname !== expectedHost)
  ) {
    throw new PublicOAuthError(
      503,
      `Authentication configuration ${name} is invalid.`,
    );
  }
  return url;
}

export function readAuthConfiguration(env: Env): AuthConfiguration {
  let baseUrl: URL;
  try {
    baseUrl = new URL(configured(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL"));
  } catch (error) {
    if (error instanceof PublicOAuthError) throw error;
    throw new PublicOAuthError(
      503,
      "Authentication configuration PUBLIC_BASE_URL is invalid.",
    );
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.pathname !== "/" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    throw new PublicOAuthError(
      503,
      "Authentication configuration PUBLIC_BASE_URL is invalid.",
    );
  }

  const issuer = configured(env.ACCESS_ISSUER, "ACCESS_ISSUER").replace(
    /\/$/u,
    "",
  );
  const issuerUrl = accessUrl(issuer, "ACCESS_ISSUER");
  const cookieKey = configured(
    env.COOKIE_ENCRYPTION_KEY,
    "COOKIE_ENCRYPTION_KEY",
  );
  if (encoder.encode(cookieKey).byteLength < 32) {
    throw new PublicOAuthError(
      503,
      "Authentication configuration COOKIE_ENCRYPTION_KEY is invalid.",
    );
  }

  return {
    baseUrl,
    clientId: configured(env.ACCESS_CLIENT_ID, "ACCESS_CLIENT_ID"),
    clientSecret: configured(env.ACCESS_CLIENT_SECRET, "ACCESS_CLIENT_SECRET"),
    authorizationUrl: accessUrl(
      configured(env.ACCESS_AUTHORIZATION_URL, "ACCESS_AUTHORIZATION_URL"),
      "ACCESS_AUTHORIZATION_URL",
      issuerUrl.hostname,
    ),
    tokenUrl: accessUrl(
      configured(env.ACCESS_TOKEN_URL, "ACCESS_TOKEN_URL"),
      "ACCESS_TOKEN_URL",
      issuerUrl.hostname,
    ),
    jwksUrl: accessUrl(
      configured(env.ACCESS_JWKS_URL, "ACCESS_JWKS_URL"),
      "ACCESS_JWKS_URL",
      issuerUrl.hostname,
    ),
    issuer,
    cookieKey,
    ownerEmail: configured(env.OWNER_EMAIL, "OWNER_EMAIL")
      .normalize("NFKC")
      .toLowerCase(),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function randomToken(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(value: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function signedTransactionId(
  id: string,
  secret: string,
): Promise<string> {
  return `${id}.${await hmac(id, secret)}`;
}

async function verifyTransactionId(
  value: string,
  secret: string,
): Promise<string> {
  const separator = value.lastIndexOf(".");
  if (separator <= 0)
    throw new PublicOAuthError(400, "Invalid OAuth transaction.");
  const id = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = await hmac(id, secret);
  if (!constantTimeEqual(signature, expected)) {
    throw new PublicOAuthError(400, "Invalid OAuth transaction.");
  }
  return id;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return rest.join("=");
  }
  return undefined;
}

function secureCookie(
  name: string,
  value: string,
  maxAge = TRANSACTION_TTL_SECONDS,
): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearOauthCookies(): string[] {
  return [
    secureCookie(CONSENT_COOKIE, "", 0),
    secureCookie(OIDC_COOKIE, "", 0),
  ];
}

function assertFresh(createdAt: number): void {
  const age = Date.now() - createdAt;
  if (age < 0 || age > TRANSACTION_TTL_SECONDS * 1000) {
    throw new PublicOAuthError(400, "OAuth transaction expired.");
  }
}

async function storeTransaction(
  env: Env,
  id: string,
  kind: TransactionKind,
  payload: ConsentTransaction | OidcTransaction,
): Promise<void> {
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM oauth_transactions WHERE expires_at < ?",
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO oauth_transactions (id, kind, payload_json, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(
        id,
        kind,
        JSON.stringify(payload),
        now + TRANSACTION_TTL_SECONDS * 1000,
      ),
    ]);
  } catch {
    throw new PublicOAuthError(
      503,
      "Authentication state is temporarily unavailable.",
    );
  }
}

async function readTransaction<T>(
  env: Env,
  id: string,
  kind: TransactionKind,
  invalidMessage: string,
): Promise<T> {
  let row: TransactionRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT payload_json, expires_at
       FROM oauth_transactions
       WHERE id = ? AND kind = ?`,
    )
      .bind(id, kind)
      .first<TransactionRow>();
  } catch {
    throw new PublicOAuthError(
      503,
      "Authentication state is temporarily unavailable.",
    );
  }
  if (!row || row.expires_at < Date.now()) {
    throw new PublicOAuthError(400, invalidMessage);
  }
  try {
    return JSON.parse(row.payload_json) as T;
  } catch {
    throw new PublicOAuthError(400, invalidMessage);
  }
}

async function deleteTransaction(
  env: Env,
  id: string,
  kind: TransactionKind,
): Promise<void> {
  try {
    const consumed = await env.DB.prepare(
      "DELETE FROM oauth_transactions WHERE id = ? AND kind = ? RETURNING id",
    )
      .bind(id, kind)
      .first();
    if (!consumed)
      throw new PublicOAuthError(400, "OAuth transaction already consumed.");
  } catch (error) {
    if (error instanceof PublicOAuthError) throw error;
    throw new PublicOAuthError(
      503,
      "Authentication state is temporarily unavailable.",
    );
  }
}

export async function createConsentTransaction(
  env: Env,
  config: AuthConfiguration,
  oauthRequest: AuthRequest,
): Promise<{ transaction: string; csrf: string; setCookie: string }> {
  const id = crypto.randomUUID();
  const browserSecret = randomToken();
  const csrf = randomToken();
  const stored: ConsentTransaction = {
    oauthRequest,
    csrfHash: await sha256(csrf),
    browserHash: await sha256(browserSecret),
    createdAt: Date.now(),
  };
  await storeTransaction(env, id, "consent", stored);
  return {
    transaction: await signedTransactionId(id, config.cookieKey),
    csrf,
    setCookie: secureCookie(CONSENT_COOKIE, browserSecret),
  };
}

export async function consumeConsentTransaction(
  request: Request,
  env: Env,
  config: AuthConfiguration,
  transactionToken: string,
  csrf: string,
): Promise<AuthRequest> {
  const id = await verifyTransactionId(transactionToken, config.cookieKey);
  const stored = await readTransaction<ConsentTransaction>(
    env,
    id,
    "consent",
    "Invalid or expired OAuth transaction.",
  );
  assertFresh(stored.createdAt);

  const browserSecret = readCookie(request, CONSENT_COOKIE);
  if (
    !browserSecret ||
    !constantTimeEqual(await sha256(browserSecret), stored.browserHash) ||
    !constantTimeEqual(await sha256(csrf), stored.csrfHash)
  ) {
    throw new PublicOAuthError(400, "OAuth browser or CSRF validation failed.");
  }

  await deleteTransaction(env, id, "consent");
  return stored.oauthRequest;
}

async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(64);
  return { verifier, challenge: await sha256(verifier) };
}

export async function createOidcRedirect(
  env: Env,
  config: AuthConfiguration,
  oauthRequest: AuthRequest,
): Promise<{ location: string; setCookie: string }> {
  const id = crypto.randomUUID();
  const browserSecret = randomToken();
  const nonce = randomToken();
  const { verifier, challenge } = await createPkce();
  const stored: OidcTransaction = {
    oauthRequest,
    codeVerifier: verifier,
    nonce,
    browserHash: await sha256(browserSecret),
    createdAt: Date.now(),
  };
  await storeTransaction(env, id, "oidc", stored);

  const state = await signedTransactionId(id, config.cookieKey);
  const authorize = new URL(config.authorizationUrl);
  authorize.search = "";
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set(
    "redirect_uri",
    new URL("/callback", config.baseUrl).href,
  );
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  return {
    location: authorize.href,
    setCookie: secureCookie(OIDC_COOKIE, browserSecret),
  };
}

export async function consumeOidcTransaction(
  request: Request,
  env: Env,
  config: AuthConfiguration,
): Promise<OidcTransaction> {
  const state = new URL(request.url).searchParams.get("state");
  if (!state) throw new PublicOAuthError(400, "Missing OAuth state.");
  const id = await verifyTransactionId(state, config.cookieKey);
  const stored = await readTransaction<OidcTransaction>(
    env,
    id,
    "oidc",
    "Invalid or expired OAuth state.",
  );
  assertFresh(stored.createdAt);

  const browserSecret = readCookie(request, OIDC_COOKIE);
  if (
    !browserSecret ||
    !constantTimeEqual(await sha256(browserSecret), stored.browserHash)
  ) {
    throw new PublicOAuthError(400, "OAuth browser validation failed.");
  }

  await deleteTransaction(env, id, "oidc");
  return stored;
}

export async function exchangeAccessCode(
  code: string,
  verifier: string,
  config: AuthConfiguration,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: new URL("/callback", config.baseUrl).href,
    code_verifier: verifier,
  });
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    throw new PublicOAuthError(
      503,
      "Cloudflare Access is temporarily unavailable.",
    );
  }
  if (!response.ok) {
    throw new PublicOAuthError(401, "Cloudflare Access rejected the login.");
  }
  const result = (await response.json()) as { id_token?: unknown };
  if (typeof result.id_token !== "string") {
    throw new PublicOAuthError(
      401,
      "Cloudflare Access returned an invalid login response.",
    );
  }
  return result.id_token;
}

export async function verifyAccessIdToken(
  idToken: string,
  nonce: string,
  config: AuthConfiguration,
): Promise<AccessClaims> {
  try {
    const keySet = createRemoteJWKSet(config.jwksUrl, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 3_600_000,
    });
    const { payload } = await jwtVerify(idToken, keySet, {
      algorithms: ["RS256"],
      issuer: config.issuer,
      audience: config.clientId,
      clockTolerance: 5,
      maxTokenAge: "10 minutes",
      requiredClaims: ["sub", "email", "exp", "iat", "nonce"],
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.nonce !== "string" ||
      !constantTimeEqual(payload.nonce, nonce)
    ) {
      throw new Error("Missing identity claims");
    }
    if (
      payload.email.normalize("NFKC").trim().toLowerCase() !== config.ownerEmail
    ) {
      throw new PublicOAuthError(
        403,
        "This identity is not allowed to use the development toolbox.",
      );
    }
    return payload as AccessClaims;
  } catch (error) {
    if (error instanceof PublicOAuthError) throw error;
    throw new PublicOAuthError(
      401,
      "Cloudflare Access returned an invalid identity token.",
    );
  }
}

export async function stableUserId(
  issuer: string,
  subject: string,
): Promise<string> {
  return `owner-${(await sha256(`${issuer}\u0000${subject}`)).slice(0, 32)}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      default:
        return "&quot;";
    }
  });
}
