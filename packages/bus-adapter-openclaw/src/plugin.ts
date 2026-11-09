// The bundle entry (dist/index.js). OpenClaw supplies this import.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginApi } from "./api.ts";
import { registerBus } from "./register.ts";
import { processBus } from "./singleton.ts";

export default definePluginEntry({
  id: "oa-bus",
  name: "Open Artifacts bus",
  description: "Message other agents over the Open Artifacts bus.",
  register(api: PluginApi) {
    registerBus(api, processBus());
  },
});
