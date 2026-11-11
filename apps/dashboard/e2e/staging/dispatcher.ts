// T19 talks to staging with Node's fetch (undici), not Playwright's request
// context. A keep-alive socket the server or an edge already closed fails the
// next request with ECONNRESET, so drop sockets idle for over about a second
// (red-line run 43068014273 lost requests this way). Imported for its effect.
import { Agent, setGlobalDispatcher } from "undici";

export const KEEP_ALIVE_TIMEOUT_MS = 1000;

/** Both: an upstream "Keep-Alive: timeout=60" would otherwise override keepAliveTimeout. */
export const keepAliveOptions = {
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT_MS,
} as const;

setGlobalDispatcher(new Agent(keepAliveOptions));
