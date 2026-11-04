import { fileURLToPath } from "node:url";

/** The TUI plugin `oa-bus install` copies into its own folder as tui.js. */
export const OPENCODE_TUI_PLUGIN = fileURLToPath(
  new URL("../assets/opencode-tui/tui.js", import.meta.url),
);
export {
  type Api,
  type OpenCodeSession,
  opencodeApi,
  rootOf,
  rootSession,
} from "./session.ts";
export {
  handleToolCall,
  SESSION_META,
  TOOLS,
  type ToolResult,
} from "./tools.ts";
export {
  compareVersions,
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  parseOpencodeVersion,
  supportsPromptId,
} from "./version.ts";
