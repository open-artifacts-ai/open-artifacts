import { boundFetch } from "../src/fetch-timeout.ts";

// Every live fetch is bounded (src/fetch-timeout.ts), including the ones
// helpers and Backend's surface probes make with the global fetch.
globalThis.fetch = boundFetch(globalThis.fetch);
