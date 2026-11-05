// Everything the runtime takes from the @oa/shared contract at run time, split
// into a lazy chunk: zod alone is several times the 8 KB gzip entry budget.
// The entry loads it once, eagerly, at startup.
export {
  PROTOCOL_VERSION,
  parseShellMessage,
  RUNTIME_PARAMS,
  RUNTIME_RESULTS,
  sendToShell,
} from "@oa/shared";
export { createComments } from "./comments.js";
