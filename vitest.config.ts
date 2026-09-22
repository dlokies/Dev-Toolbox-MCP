/// <reference types="node" />
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.resolve("migrations")),
          ACCESS_CLIENT_ID: "access-test-client",
          ACCESS_CLIENT_SECRET: "access-test-secret",
          ACCESS_AUTHORIZATION_URL:
            "https://test.cloudflareaccess.com/authorize",
          ACCESS_TOKEN_URL: "https://test.cloudflareaccess.com/token",
          ACCESS_JWKS_URL: "https://test.cloudflareaccess.com/jwks",
          ACCESS_ISSUER: "https://test.cloudflareaccess.com/oidc",
          COOKIE_ENCRYPTION_KEY:
            "test-only-cookie-key-with-at-least-thirty-two-bytes",
          OWNER_EMAIL: "owner@example.com",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 15_000,
  },
});
