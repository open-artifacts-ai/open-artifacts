import type { Env as AppEnv } from "../src/env.js";

declare global {
  namespace Cloudflare {
    // The test pool binds OAUTH_KV (wrangler.test.jsonc); the app's Env has
    // it optional (unbound is fine with OAUTH_STORE=d1).
    interface Env extends AppEnv {
      OAUTH_KV: KVNamespace;
    }
  }
}
