import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends Pick<
      WorkerEnv,
      | "ACCESS_CLIENT_SECRET"
      | "COOKIE_ENCRYPTION_KEY"
      | "OWNER_EMAIL"
      | "OAUTH_PROVIDER"
    > {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
