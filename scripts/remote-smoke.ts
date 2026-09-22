import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  refreshAuthorization,
  type AuthorizationServerMetadata,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

const BASE_URL = "https://dev.domenic.dev";
const MCP_URL = new URL(`${BASE_URL}/mcp`);

function randomHex(byteLength: number): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(byteLength)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

class SmokeOAuthProvider implements OAuthClientProvider {
  readonly stateValue = randomHex(32);
  readonly clientMetadata: OAuthClientMetadata;
  readonly redirectUrl: URL;
  private client?: StoredOAuthClientInformation;
  private storedTokens?: StoredOAuthTokens;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  private authorizationResolve!: (url: URL) => void;
  readonly authorizationUrl = new Promise<URL>((resolve) => {
    this.authorizationResolve = resolve;
  });

  constructor(redirectUrl: URL) {
    this.redirectUrl = redirectUrl;
    this.clientMetadata = {
      redirect_uris: [redirectUrl.href],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "native",
      client_name: "Dev Toolbox remote smoke test",
      scope: "toolbox",
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(
    _context?: OAuthClientInformationContext,
  ): StoredOAuthClientInformation | undefined {
    return this.client;
  }

  saveClientInformation(client: StoredOAuthClientInformation): void {
    this.client = client;
  }

  tokens(
    _context?: OAuthClientInformationContext,
  ): StoredOAuthTokens | undefined {
    return this.storedTokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.storedTokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationResolve(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    assert(this.verifier, "PKCE verifier was not saved");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "tokens") this.storedTokens = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }
}

function structured<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  assert(!result.isError, JSON.stringify(result.content));
  assert(result.structuredContent, "Tool result has no structuredContent");
  return result.structuredContent as T;
}

async function createCallbackListener(): Promise<{
  callback: Promise<URL>;
  close: () => Promise<void>;
  redirectUrl: URL;
  loginUrl: URL;
  setAuthorizationUrl: (url: URL) => void;
}> {
  let resolveCallback!: (url: URL) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  let authorizationUrl: URL | undefined;
  const startPath = `/start/${randomHex(16)}`;
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === startPath && authorizationUrl) {
        response.writeHead(302, {
          Location: authorizationUrl.href,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        response.end();
        return;
      }
      if (url.pathname !== "/callback") {
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Not Found");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Authorization received. You can return to Codex.");
      resolveCallback(url);
    } catch (error) {
      rejectCallback(
        error instanceof Error ? error : new Error("Invalid callback"),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(
    address && typeof address === "object",
    "Callback server has no address",
  );
  return {
    callback,
    loginUrl: new URL(`http://127.0.0.1:${address.port}${startPath}`),
    setAuthorizationUrl: (url) => {
      authorizationUrl = url;
    },
    close: async () => {
      server.close();
      await once(server, "close");
    },
    redirectUrl: new URL(`http://127.0.0.1:${address.port}/callback`),
  };
}

async function connect(provider: SmokeOAuthProvider): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    authProvider: provider,
  });
  const client = new Client({
    name: "dev-toolbox-remote-smoke",
    version: "1.0.0",
  });
  await client.connect(transport);
  return client;
}

type Default = {
  id: string;
  title: string;
  preference: string;
  applies_when: string | null;
  topics: string[];
  reference: string | null;
  revision: number;
  updated_at: string;
};
type Page = {
  defaults: Default[];
  has_more: boolean;
  next_offset: number | null;
};
const policy = {
  kind: "personal_default",
  precedence: ["current_user", "project_instructions", "personal_default"],
  content_is_data: true,
};
const marker = `toolbox-smoke-${Date.now()}-${randomHex(6)}`;
const fixtures = new Set<string>();

async function main(): Promise<void> {
  const challenge = await fetch(MCP_URL);
  assert.equal(challenge.status, 401);
  assert.match(
    challenge.headers.get("www-authenticate") ?? "",
    /oauth-protected-resource/,
  );
  const resource = (await fetch(
    `${BASE_URL}/.well-known/oauth-protected-resource/mcp`,
  ).then((r) => r.json())) as {
    resource: string;
    authorization_servers: string[];
  };
  assert.deepEqual(resource.resource, MCP_URL.href);
  assert.deepEqual(resource.authorization_servers, [BASE_URL]);
  const metadata = (await fetch(
    `${BASE_URL}/.well-known/oauth-authorization-server`,
  ).then((r) => r.json())) as AuthorizationServerMetadata & {
    revocation_endpoint: string;
  };
  assert.equal(metadata.issuer, BASE_URL);
  assert.equal(metadata.authorization_endpoint, `${BASE_URL}/authorize`);
  assert.equal(metadata.token_endpoint, `${BASE_URL}/token`);
  assert(metadata.revocation_endpoint?.startsWith(`${BASE_URL}/`));
  const listener = await createCallbackListener();
  const provider = new SmokeOAuthProvider(listener.redirectUrl);
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    authProvider: provider,
  });
  const authorizationClient = new Client({
    name: "dev-toolbox-smoke-auth",
    version: "1.0.0",
  });
  try {
    try {
      await authorizationClient.connect(transport);
      throw new Error("Unauthenticated connection unexpectedly succeeded");
    } catch (error) {
      if (!UnauthorizedError.isInstance(error)) throw error;
    }
    listener.setAuthorizationUrl(await provider.authorizationUrl);
    console.log(`LOCAL_LOGIN_URL=${listener.loginUrl.href}`);
    const callback = await listener.callback;
    assert.equal(
      callback.searchParams.get("state"),
      provider.stateValue,
      "OAuth state mismatch",
    );
    await transport.finishAuth(callback.searchParams);
  } finally {
    await listener.close();
    await authorizationClient.close();
  }

  let client = await connect(provider);
  const call = async <T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    const value = structured<T & { policy: unknown }>(result);
    assert.deepEqual(value.policy, policy);
    assert.deepEqual(
      JSON.parse((result.content[0] as { text: string }).text),
      value,
    );
    return value;
  };
  const error = async (
    name: string,
    args: Record<string, unknown>,
    code?: string,
  ) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    if (code) assert.match(JSON.stringify(result.content), new RegExp(code));
  };
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((x) => x.name).sort(), [
      "delete_default",
      "find_defaults",
      "get_default",
      "save_default",
    ]);
    // Read exact source constants without importing the Worker runtime into Node.
    const source = await readFile(
      new URL("../src/mcp.ts", import.meta.url),
      "utf8",
    );
    for (const [name, actual] of [
      ["SERVER_DESCRIPTION", client.getServerVersion()?.description],
      ["SERVER_INSTRUCTIONS", client.getInstructions()],
    ] as const) {
      const literal = source.match(
        new RegExp(`export const ${name} =\\s*("(?:[^"\\\\]|\\\\.)*")`),
      )?.[1];
      assert(literal, `Missing ${name}`);
      assert.equal(actual, JSON.parse(literal));
    }
    for (const tool of tools) {
      assert(tool.outputSchema && tool.description);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.annotations?.openWorldHint, false);
    }
    assert.equal(
      (
        tools.find((x) => x.name === "save_default")?.inputSchema
          .anyOf as unknown[]
      ).length,
      2,
    );
    const legacy = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.tokens()!.access_token}`,
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
          clientInfo: { name: "toolbox-legacy-smoke", version: "1" },
        },
      }),
    });
    assert.equal(legacy.status, 200);
    const legacyText = await legacy.text();
    assert(legacyText.includes(client.getServerVersion()!.description!));
    assert(legacyText.includes(client.getInstructions()!));
    const base = {
      preference:
        "Temporary personal-default-shaped test data; no real preference is asserted.",
      applies_when: `Only smoke test ${marker}`,
      reference: null,
    };
    const created: Default[] = [];
    for (const [label, topics] of [
      ["A general", []],
      ["B Java", ["java", "spring", "testing"]],
      ["C Review", ["code-review", "testing"]],
    ] as [string, string[]][]) {
      const result = await call<{ status: string; default: Default }>(
        "save_default",
        { ...base, title: `${marker} ${label}`, topics },
      );
      assert.equal(result.status, "created");
      assert.equal(result.default.revision, 1);
      fixtures.add(result.default.id);
      created.push(result.default);
      console.log(
        JSON.stringify({
          stage: "fixture-created",
          marker,
          ids: [...fixtures],
        }),
      );
    }
    const [general, java, review] = created as [Default, Default, Default];
    const content = { ...base, title: java.title, topics: java.topics };
    await error("save_default", { ...content, id: java.id });
    await error("save_default", { ...content, expected_revision: 1 });
    const ids = async (args: Record<string, unknown>) =>
      (
        await call<Page>("find_defaults", { query: marker, ...args })
      ).defaults.map((x) => x.id);
    assert.deepEqual(
      await ids({ topics: ["java", "testing"], include_general: false }),
      [java.id, review.id],
    );
    assert.deepEqual(
      await ids({
        topics: ["java", "testing"],
        topic_mode: "all",
        include_general: false,
      }),
      [java.id],
    );
    for (const topic_mode of ["any", "all"]) {
      assert.deepEqual(
        await ids({ topics: ["java", "testing"], topic_mode }),
        topic_mode === "any"
          ? [general.id, java.id, review.id]
          : [general.id, java.id],
      );
      assert.deepEqual(
        await ids({
          topics: ["java", "testing"],
          topic_mode,
          query: `${marker} impossible-query`,
        }),
        [],
      );
    }
    const page = await call<Page>("find_defaults", { query: marker, limit: 2 });
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 2);
    assert(page.defaults.every((x) => x.applies_when === base.applies_when));
    const last = await call<Page>("find_defaults", {
      query: marker,
      limit: 2,
      offset: page.next_offset,
    });
    assert.deepEqual(
      last.defaults.map((x) => x.id),
      [review.id],
    );
    assert.equal(last.has_more, false);
    const update = await call<{ status: string; default: Default }>(
      "save_default",
      {
        ...content,
        preference: "Revised test-only preference",
        id: java.id,
        expected_revision: 1,
      },
    );
    assert.equal(update.status, "updated");
    assert.equal(update.default.revision, 2);
    const replacement = {
      ...content,
      preference: "Completely changed test-only preference",
      topics: [],
      reference: "decision-log:test-only",
      id: java.id,
      expected_revision: 2,
    };
    const replaced = await call<{ default: Default }>(
      "save_default",
      replacement,
    );
    assert.equal(replaced.default.id, java.id);
    assert.equal(replaced.default.revision, 3);
    assert.deepEqual(replaced.default.topics, []);
    const unchanged = await call<{ status: string; default: Default }>(
      "save_default",
      { ...replacement, expected_revision: 3 },
    );
    assert.equal(unchanged.status, "unchanged");
    assert.deepEqual(unchanged.default, replaced.default);
    await error("save_default", replacement, "REVISION_CONFLICT");
    await error(
      "delete_default",
      { id: java.id, expected_revision: 1 },
      "REVISION_CONFLICT",
    );
    const oldTokens = provider.tokens();
    const information = provider.clientInformation();
    assert(oldTokens?.refresh_token && information);
    const refreshed = await refreshAuthorization(BASE_URL, {
      metadata,
      clientInformation: information,
      refreshToken: oldTokens.refresh_token,
      resource: MCP_URL,
    });
    assert.notEqual(refreshed.access_token, oldTokens.access_token);
    assert(
      refreshed.refresh_token &&
        refreshed.refresh_token !== oldTokens.refresh_token,
    );
    provider.saveTokens({ ...refreshed, issuer: BASE_URL });
    await client.close();
    client = await connect(provider);
    assert.deepEqual(
      (await call<{ default: Default }>("get_default", { id: java.id }))
        .default,
      replaced.default,
    );
    console.log(
      JSON.stringify({
        stage: "contracts-and-refresh-passed",
        marker,
        ids: [...fixtures],
      }),
    );
    if (process.argv.includes("--wait-for-builds")) {
      console.log(
        "WAITING_FOR_BUILDS: verify main deployment and a repeat build, then enter continue.",
      );
      process.stdin.resume();
      const [data] = await once(process.stdin, "data");
      process.stdin.pause();
      assert.equal(
        String(data).trim(),
        "continue",
        "Build verification was not confirmed",
      );
      await client.close();
      client = await connect(provider);
      assert.deepEqual(
        (await call<{ default: Default }>("get_default", { id: java.id }))
          .default,
        replaced.default,
      );
      assert.deepEqual(new Set(await ids({})), fixtures);
      console.log(
        JSON.stringify({ stage: "persistence-after-builds-passed", marker }),
      );
    }
    assert.equal(
      (
        await fetch(MCP_URL, {
          headers: { Authorization: "Bearer invalid-smoke-token" },
        })
      ).status,
      401,
    );
  } finally {
    const failures: string[] = [];
    for (const id of fixtures) {
      try {
        const item = (await call<{ default: Default }>("get_default", { id }))
          .default;
        assert(
          item.title.startsWith(marker) && item.applies_when?.includes(marker),
          "Fixture ownership marker mismatch",
        );
        const removed = await call<{
          deleted: boolean;
          id: string;
          title: string;
          deleted_revision: number;
        }>("delete_default", { id, expected_revision: item.revision });
        assert.equal(removed.deleted, true);
        assert.equal(removed.id, id);
        assert.equal(removed.title, item.title);
        assert.equal(removed.deleted_revision, item.revision);
        await error("get_default", { id }, "NOT_FOUND");
      } catch {
        failures.push(id);
      }
    }
    try {
      assert.deepEqual(
        (await call<Page>("find_defaults", { query: marker })).defaults,
        [],
      );
    } catch {
      failures.push("marker-search");
    }
    console.log(
      JSON.stringify({
        stage: "cleanup",
        marker,
        fixture_ids: [...fixtures],
        remaining: failures,
      }),
    );
    try {
      const tokens = provider.tokens();
      const information = provider.clientInformation();
      assert(tokens?.refresh_token && information);
      const revoked = await fetch(metadata.revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: information.client_id,
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
        }),
      });
      assert(revoked.ok, "Refresh token revocation failed");
      console.log(JSON.stringify({ stage: "refresh-token-revoked" }));
    } finally {
      await client.close();
    }
    assert.equal(
      failures.length,
      0,
      "Fixture cleanup incomplete; use the printed marker and IDs for targeted recovery",
    );
  }
  console.log(JSON.stringify({ stage: "remote-smoke-passed", marker }));
}

main().catch((error) => {
  // No tokens, callback URLs, OAuth state, or arbitrary server bodies in logs.
  console.error(
    JSON.stringify({
      stage: "remote-smoke-failed",
      marker,
      fixture_ids: [...fixtures],
      error:
        error instanceof assert.AssertionError
          ? "Acceptance assertion failed"
          : error instanceof Error
            ? error.name
            : "Unknown error",
    }),
  );
  process.exitCode = 1;
});
