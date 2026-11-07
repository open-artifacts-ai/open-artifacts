declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { PluginApi } from "./api.ts";
  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
  }): unknown;
}
