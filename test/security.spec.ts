import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../src/env";
import worker from "../src/index";
import { validAuthProps } from "../src/authorization";
import {
  consumeConsentTransaction,
  consumeOidcTransaction,
  createConsentTransaction,
  createOidcRedirect,
  exchangeAccessCode,
  readAuthConfiguration,
  verifyAccessIdToken,
} from "../src/oauth-utils";
import { network } from "./network";

const config = () => readAuthConfiguration(env as Env);
const request = {
  clientId: "test",
  redirectUri: "https://client.example/callback",
  scope: ["toolbox"],
  responseType: "code",
  state: "test",
} as AuthRequest;
const context = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
const base = "https://dev.domenic.dev";
describe("our OAuth security boundaries", () => {
  it("checks CSRF, browser binding, expiry, signed state and single-use transactions", async () => {
    const consent = await createConsentTransaction(
      env as Env,
      config(),
      request,
    );
    const browser = new Request(base + "/authorize", {
      headers: { Cookie: consent.setCookie },
    });
    for (const attribute of [
      "__Host-DEVTOOLBOX_CONSENT",
      "Secure",
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
    ])
      expect(consent.setCookie).toContain(attribute);
    await expect(
      consumeConsentTransaction(
        browser,
        env as Env,
        config(),
        consent.transaction,
        "wrong",
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      consumeConsentTransaction(
        new Request(base),
        env as Env,
        config(),
        consent.transaction,
        consent.csrf,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      consumeConsentTransaction(
        browser,
        env as Env,
        config(),
        consent.transaction + "x",
        consent.csrf,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        consumeConsentTransaction(
          browser,
          env as Env,
          config(),
          consent.transaction,
          consent.csrf,
        ),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const expired = await createConsentTransaction(
      env as Env,
      config(),
      request,
    );
    await env.DB.prepare(
      "UPDATE oauth_transactions SET expires_at = 0 WHERE id = ?",
    )
      .bind(expired.transaction.split(".")[0])
      .run();
    await expect(
      consumeConsentTransaction(
        new Request(base, { headers: { Cookie: expired.setCookie } }),
        env as Env,
        config(),
        expired.transaction,
        expired.csrf,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const oidc = await createOidcRedirect(env as Env, config(), request);
    const url = new URL(base + "/callback");
    url.searchParams.set(
      "state",
      new URL(oidc.location).searchParams.get("state")!,
    );
    await expect(
      consumeOidcTransaction(new Request(url), env as Env, config()),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await consumeOidcTransaction(
          new Request(url, { headers: { Cookie: oidc.setCookie } }),
          env as Env,
          config(),
        )
      ).oauthRequest.clientId,
    ).toBe("test");
  });
  it.each([
    "nonce",
    "issuer",
    "audience",
    "expired",
    "future",
    "subject",
    "email",
  ])("rejects invalid upstream %s", async (kind) => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "security-key";
    network.use(
      http.get(config().jwksUrl.href, () => HttpResponse.json({ keys: [jwk] })),
    );
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      email: kind === "email" ? "attacker@example.com" : "owner@example.com",
      nonce: kind === "nonce" ? "wrong" : "nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(kind === "issuer" ? "https://wrong.example" : config().issuer)
      .setAudience(kind === "audience" ? "wrong" : config().clientId)
      .setIssuedAt(kind === "future" ? now + 60 : now)
      .setExpirationTime(kind === "expired" ? now - 60 : now + 300);
    if (kind !== "subject") jwt.setSubject("owner");
    await expect(
      verifyAccessIdToken(await jwt.sign(privateKey), "nonce", config()),
    ).rejects.toMatchObject({ status: kind === "email" ? 403 : 401 });
  });
  it("fails closed on missing config, D1 and upstream failure", async () => {
    expect(() =>
      readAuthConfiguration({ ...env, OWNER_EMAIL: undefined } as Env),
    ).toThrow();
    const failedKv = await worker.fetch(
      new Request(base + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "storage failure",
          redirect_uris: ["https://client.example/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
      {
        ...env,
        OAUTH_KV: {
          put() {
            throw new Error("private storage failure");
          },
        },
      } as unknown as Env,
      context,
    );
    expect(failedKv.status).toBeGreaterThanOrEqual(500);
    expect(await failedKv.text()).not.toContain("private storage failure");
    const broken = {
      ...env,
      DB: {
        batch() {
          throw new Error("private SQL failure");
        },
      },
    } as unknown as Env;
    await expect(
      createConsentTransaction(broken, config(), request),
    ).rejects.toMatchObject({
      status: 503,
      message: "Authentication state is temporarily unavailable.",
    });
    network.use(http.post(config().tokenUrl.href, () => HttpResponse.error()));
    await expect(
      exchangeAccessCode("code", "verifier", config()),
    ).rejects.toMatchObject({ status: 503 });
    network.use(http.get(config().jwksUrl.href, () => HttpResponse.error()));
    await expect(
      verifyAccessIdToken("invalid", "nonce", config()),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("validates login age and permission props", () => {
    const now = Date.now();
    const props = {
      email: "owner@example.com",
      subject: "owner",
      permissions: ["toolbox"],
      authenticatedAt: now,
      loginExpiresAt: now + 604800000,
    };
    expect(validAuthProps(props)).toBe(true);
    for (const change of [
      { permissions: [] },
      { permissions: ["inventory"] },
      { authenticatedAt: now + 10000 },
      { loginExpiresAt: now + 604800001 },
      { subject: "" },
    ])
      expect(validAuthProps({ ...props, ...change })).toBe(false);
  });
  it("uses canonical discovery despite hostile request headers and bounds requests", async () => {
    const response = await worker.fetch(
      new Request(base + "/.well-known/oauth-authorization-server", {
        headers: {
          Host: "evil.example",
          "X-Forwarded-Host": "evil.example",
          Forwarded: "host=evil.example",
        },
      }),
      env as Env,
      context,
    );
    expect(await response.json()).toMatchObject({
      issuer: base,
      authorization_endpoint: base + "/authorize",
      token_endpoint: base + "/token",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const huge = await worker.fetch(
      new Request(base + "/mcp", { method: "POST", body: "x".repeat(65537) }),
      env as Env,
      context,
    );
    expect(huge.status).toBe(413);
    const hidden = await worker.fetch(
      new Request(base + "/defaults"),
      env as Env,
      context,
    );
    expect(hidden.status).toBe(404);
  });
});
