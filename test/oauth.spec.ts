import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { network } from "./network";
import {
  SERVER_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTIONS,
} from "../src/mcp";

import { POLICY } from "../src/model";

const BASE_URL = "https://dev.domenic.dev";
const RESOURCE = `${BASE_URL}/mcp`;
const REDIRECT_URI = "https://client.example/callback";
const ISSUER = "https://test.cloudflareaccess.com/oidc";
const ACCESS_CLIENT_ID = "access-test-client";

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

async function workerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  request.headers.set("Host", new URL(request.url).host);
  return worker.fetch(request, env as Env, executionContext());
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}

function hidden(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`, "u"));
  if (!match?.[1]) throw new Error(`Missing ${name} input`);
  return match[1]
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&gt;/gu, ">")
    .replace(/&lt;/gu, "<")
    .replace(/&amp;/gu, "&");
}

async function registerClient(): Promise<string> {
  const response = await workerFetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Dev Toolbox Test Client",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

interface AuthorizedTokens {
  accessToken: string;
  refreshToken: string;
  clientId: string;
}

async function authorize(
  ownerEmail = "owner@example.com",
): Promise<AuthorizedTokens> {
  const clientId = await registerClient();
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const authorizeUrl = new URL(`${BASE_URL}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", "toolbox");
  authorizeUrl.searchParams.set("resource", RESOURCE);
  authorizeUrl.searchParams.set("state", "client-state");
  authorizeUrl.searchParams.set(
    "code_challenge",
    await pkceChallenge(verifier),
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const consentResponse = await workerFetch(authorizeUrl);
  expect(consentResponse.status).toBe(200);
  expect(consentResponse.headers.get("Content-Security-Policy")).toContain(
    "form-action 'self' https://test.cloudflareaccess.com",
  );
  const consentCookie = consentResponse.headers.get("Set-Cookie");
  expect(consentCookie).toContain("__Host-DEVTOOLBOX_CONSENT");
  const consentHtml = await consentResponse.text();

  const approval = await workerFetch(`${BASE_URL}/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: consentCookie ?? "",
    },
    body: new URLSearchParams({
      transaction: hidden(consentHtml, "transaction"),
      csrf: hidden(consentHtml, "csrf"),
      decision: "approve",
    }),
  });
  expect(approval.status).toBe(302);
  expect(approval.headers.get("Content-Security-Policy")).toBeNull();
  const accessLocation = new URL(approval.headers.get("Location") ?? "");
  const oidcCookie = approval.headers.get("Set-Cookie");
  const upstreamState = accessLocation.searchParams.get("state");
  const nonce = accessLocation.searchParams.get("nonce");
  expect(accessLocation.origin).toBe("https://test.cloudflareaccess.com");
  expect(accessLocation.searchParams.get("code_challenge_method")).toBe("S256");
  expect(upstreamState).toBeTruthy();
  expect(nonce).toBeTruthy();

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  network.use(
    http.post(
      "https://test.cloudflareaccess.com/token",
      async ({ request }) => {
        const form = await request.formData();
        expect(form.get("code")).toBe("access-code");
        expect(form.get("code_verifier")).toBeTruthy();
        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({ email: ownerEmail, nonce })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(ISSUER)
          .setAudience(ACCESS_CLIENT_ID)
          .setSubject("access-owner-subject")
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
        return HttpResponse.json({
          access_token: "upstream-token-must-not-be-forwarded",
          id_token: idToken,
          token_type: "Bearer",
        });
      },
    ),
    http.get("https://test.cloudflareaccess.com/jwks", () =>
      HttpResponse.json({ keys: [publicJwk] }),
    ),
  );

  const callbackUrl = new URL(`${BASE_URL}/callback`);
  callbackUrl.searchParams.set("code", "access-code");
  callbackUrl.searchParams.set("state", upstreamState ?? "");
  const callback = await workerFetch(callbackUrl, {
    headers: { Cookie: oidcCookie ?? "" },
  });
  if (ownerEmail !== "owner@example.com") {
    expect(callback.status).toBe(403);
    await callback.text();
    throw new Error("identity-rejected");
  }
  expect(callback.status).toBe(302);
  const clientRedirect = new URL(callback.headers.get("Location") ?? "");
  expect(clientRedirect.origin).toBe("https://client.example");
  expect(clientRedirect.searchParams.get("state")).toBe("client-state");
  const authorizationCode = clientRedirect.searchParams.get("code");
  expect(authorizationCode).toBeTruthy();

  const tokenResponse = await workerFetch(`${BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorizationCode ?? "",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
  };
  expect(tokens.access_token).not.toContain("upstream-token");
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    clientId,
  };
}

function tokenFetch(accessToken: string): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("Host", new URL(request.url).host);
    request.headers.set("Authorization", `Bearer ${accessToken}`);
    return worker.fetch(request, env as Env, executionContext());
  };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM defaults").run();
  await env.DB.prepare("DELETE FROM oauth_transactions").run();
});

describe("OAuth integration", () => {
  it("publishes exact discovery and rejects unauthenticated MCP requests", async () => {
    const protectedResource = await workerFetch(
      `${BASE_URL}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [BASE_URL],
      scopes_supported: ["toolbox"],
    });

    const authorizationServer = await workerFetch(
      `${BASE_URL}/.well-known/oauth-authorization-server`,
    );
    expect(authorizationServer.status).toBe(200);
    expect(await authorizationServer.json()).toMatchObject({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/authorize`,
      token_endpoint: `${BASE_URL}/token`,
      registration_endpoint: `${BASE_URL}/register`,
    });

    const unauthenticated = await workerFetch(RESOURCE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("WWW-Authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
    await unauthenticated.text();
  });

  it("completes Access login, issues local tokens, refreshes, and reaches MCP", async () => {
    const tokens = await authorize();
    const invalidHeaders: Record<string, string>[] = [
      { Host: "evil.example" },
      { Host: "dev.domenic.dev", Origin: "https://evil.example" },
    ];
    for (const headers of invalidHeaders) {
      const rejected = await worker.fetch(
        new Request(RESOURCE, {
          method: "POST",
          headers: {
            ...headers,
            Authorization: `Bearer ${tokens.accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
        env as Env,
        executionContext(),
      );
      expect([400, 403]).toContain(rejected.status);
      await rejected.text();
    }
    const client = new Client({ name: "oauth-roundtrip", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: tokenFetch(tokens.accessToken),
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(4);
    expect(client.getServerVersion()?.description).toBe(SERVER_DESCRIPTION);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      Object.keys(TOOL_DESCRIPTIONS).sort(),
    );
    for (const tool of tools.tools) {
      expect(tool.description).toBe(
        TOOL_DESCRIPTIONS[tool.name as keyof typeof TOOL_DESCRIPTIONS],
      );
      if (tool.name === "save_default") {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.anyOf).toHaveLength(2);
        const alternatives = tool.inputSchema.anyOf as {
          additionalProperties: boolean;
          required: string[];
          properties: Record<string, unknown>;
        }[];
        expect(alternatives[0]?.additionalProperties).toBe(false);
        expect(alternatives[0]?.properties).not.toHaveProperty("id");
        expect(alternatives[0]?.properties).not.toHaveProperty(
          "expected_revision",
        );
        expect(alternatives[1]?.additionalProperties).toBe(false);
        expect(alternatives[1]?.required).toEqual(
          expect.arrayContaining(["id", "expected_revision"]),
        );
      } else expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
    const content = {
      title: "OAuth Test Default",
      preference: "Only this test uses constructor injection.",
      applies_when: "This test only",
      topics: ["Java"],
      reference: null,
    };
    for (const mixed of [
      { ...content, id: crypto.randomUUID() },
      { ...content, expected_revision: 1 },
    ]) {
      const invalid = await client.callTool({
        name: "save_default",
        arguments: mixed,
      });
      expect(invalid.isError).toBe(true);
    }
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM defaults").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    const created = await client.callTool({
      name: "save_default",
      arguments: content,
    });
    expect(created.isError).not.toBe(true);
    const fixture = (
      created.structuredContent as {
        default: { id: string; revision: number; title: string };
      }
    ).default;
    expect(created.structuredContent).toMatchObject({
      status: "created",
      policy: POLICY,
    });
    expect(JSON.parse((created.content[0] as { text: string }).text)).toEqual(
      created.structuredContent,
    );
    expect(
      tools.tools.find((tool) => tool.name === "delete_default")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(
      tools.tools.find((tool) => tool.name === "save_default")?.annotations
        ?.destructiveHint,
    ).toBe(true);
    const updated = await client.callTool({
      name: "save_default",
      arguments: {
        ...content,
        id: fixture.id,
        expected_revision: 1,
        topics: [],
        applies_when: null,
      },
    });
    expect(updated.structuredContent).toMatchObject({
      status: "updated",
      default: { revision: 2, topics: [], applies_when: null },
      policy: POLICY,
    });
    const removed = await client.callTool({
      name: "delete_default",
      arguments: { id: fixture.id, expected_revision: 2 },
    });
    expect(removed.isError).not.toBe(true);
    expect(removed.structuredContent).toEqual({
      deleted: true,
      id: fixture.id,
      title: fixture.title,
      deleted_revision: 2,
      policy: POLICY,
    });
    const legacy = await tokenFetch(tokens.accessToken)(RESOURCE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" },
        },
      }),
    });
    expect(legacy.status).toBe(200);
    const legacyText = await legacy.text();
    expect(legacyText).toContain(SERVER_DESCRIPTION);
    expect(legacyText).toContain(SERVER_INSTRUCTIONS);
    await client.close();

    const refreshResponse = await workerFetch(`${BASE_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: tokens.clientId,
        refresh_token: tokens.refreshToken,
      }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.access_token).not.toBe(tokens.accessToken);
    expect(refreshed.refresh_token).not.toBe(tokens.refreshToken);

    const refreshedClient = new Client({
      name: "oauth-refresh",
      version: "1.0.0",
    });
    await refreshedClient.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: tokenFetch(refreshed.access_token),
      }),
    );
    expect((await refreshedClient.listTools()).tools).toHaveLength(4);
    await refreshedClient.close();
  });

  it("rejects wrong identities, invalid tokens, resources, state, and callbacks", async () => {
    await expect(authorize("attacker@example.com")).rejects.toThrow(
      "identity-rejected",
    );

    const invalidToken = await tokenFetch("invalid-token")(RESOURCE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(invalidToken.status).toBe(401);
    await invalidToken.text();

    const clientId = await registerClient();
    const wrongResource = new URL(`${BASE_URL}/authorize`);
    wrongResource.searchParams.set("response_type", "code");
    wrongResource.searchParams.set("client_id", clientId);
    wrongResource.searchParams.set("redirect_uri", REDIRECT_URI);
    wrongResource.searchParams.set("resource", "https://other.example/mcp");
    wrongResource.searchParams.set(
      "code_challenge",
      await pkceChallenge("x".repeat(64)),
    );
    wrongResource.searchParams.set("code_challenge_method", "S256");
    const wrongResourceResponse = await workerFetch(wrongResource);
    expect(wrongResourceResponse.status).toBe(302);
    const wrongResourceRedirect = new URL(
      wrongResourceResponse.headers.get("Location") ?? "",
    );
    expect(wrongResourceRedirect.origin).toBe("https://client.example");
    expect(wrongResourceRedirect.searchParams.get("error")).toBe(
      "invalid_target",
    );
    await wrongResourceResponse.text();

    const badState = await workerFetch(
      `${BASE_URL}/callback?code=x&state=invalid`,
      {
        headers: { Cookie: "__Host-DEVTOOLBOX_OIDC=invalid" },
      },
    );
    expect(badState.status).toBe(400);
    await badState.text();
  });
});
