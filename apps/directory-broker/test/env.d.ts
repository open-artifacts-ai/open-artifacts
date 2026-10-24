import type { Env as DirectoryEnv } from "../src/index.js";

declare global {
  namespace Cloudflare {
    interface Env extends DirectoryEnv {}
  }
}
