import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env extends Pick<
  CloudflareBindings,
  "DB" | "OAUTH_KV" | "PUBLIC_BASE_URL"
> {
  OAUTH_PROVIDER: OAuthHelpers;
  ACCESS_CLIENT_ID?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_JWKS_URL?: string;
  ACCESS_ISSUER?: string;
  ACCESS_CLIENT_SECRET?: string;
  COOKIE_ENCRYPTION_KEY?: string;
  OWNER_EMAIL?: string;
}

export interface AuthProps {
  email: string;
  subject: string;
  permissions: ["toolbox"];
  authenticatedAt: number;
  loginExpiresAt: number;
}
