import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authHandler } from "./auth-handler";
import type { Env } from "./env";
import { toolboxApiHandler } from "./mcp";
import { validAuthProps } from "./authorization";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function createProvider(env: Env): OAuthProvider<Env> {
  const base = new URL(env.PUBLIC_BASE_URL);
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new Error("Invalid public base URL");
  }
  return new OAuthProvider<Env>({
    authorizeEndpoint: new URL("/authorize", base).href,
    tokenEndpoint: new URL("/token", base).href,
    clientRegistrationEndpoint: new URL("/register", base).href,
    apiRoute: "/mcp",
    apiHandler: toolboxApiHandler,
    defaultHandler: authHandler,
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 7 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    scopesSupported: ["toolbox"],
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: new URL("/mcp", base).href,
      authorization_servers: [base.origin],
      scopes_supported: ["toolbox"],
      bearer_methods_supported: ["header"],
      resource_name: "Dev Toolbox MCP",
    },
    tokenExchangeCallback(options) {
      const configuredOwner = env.OWNER_EMAIL?.normalize("NFKC")
        .trim()
        .toLowerCase();
      if (
        !configuredOwner ||
        !validAuthProps(options.props) ||
        options.props.email.normalize("NFKC").trim().toLowerCase() !==
          configuredOwner ||
        options.props.loginExpiresAt <= Date.now()
      ) {
        throw new OAuthError("invalid_grant", {
          description: "The login session has expired.",
          statusCode: 400,
        });
      }
      if (
        options.scope.some((scope) => scope !== "toolbox") ||
        options.requestedScope.some((scope) => scope !== "toolbox")
      ) {
        throw new OAuthError("invalid_scope", {
          description: "The requested scope is not available.",
          statusCode: 400,
        });
      }
      return {
        accessTokenProps: options.props,
        newProps: options.props,
        accessTokenScope: ["toolbox"],
        accessTokenTTL: Math.min(
          60 * 60,
          Math.ceil((options.props.loginExpiresAt - Date.now()) / 1000),
        ),
      };
    },
  });
}

async function enforceBodyLimit(request: Request): Promise<Request | Response> {
  if (request.body === null) return request;
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_REQUEST_BODY_BYTES
  ) {
    return new Response("Request body too large", { status: 413 });
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      return new Response("Request body too large", { status: 413 });
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.set("Content-Length", String(total));
  if (
    headers.get("Content-Type")?.toLowerCase().startsWith("application/json")
  ) {
    try {
      const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
      if (containsDangerousJsonKey(value)) {
        return new Response("Unsafe JSON object key", { status: 400 });
      }
    } catch {
      // The protocol-specific handler returns the appropriate malformed JSON error.
    }
  }
  return new Request(request, { body, headers });
}

function containsDangerousJsonKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsDangerousJsonKey);
  return Object.entries(value).some(
    ([key, entry]) =>
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      containsDangerousJsonKey(entry),
  );
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    try {
      const limited = await enforceBodyLimit(request);
      if (limited instanceof Response) return noStore(limited);
      return noStore(await createProvider(env).fetch(limited, env, context));
    } catch {
      return noStore(
        new Response("Service temporarily unavailable", { status: 503 }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
