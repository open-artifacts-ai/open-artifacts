import { afterAll } from "vitest";
import { getCurrentTest } from "vitest/suite";
import { boundFetch } from "../src/fetch-timeout.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { watchResets } from "../src/resets.ts";
import { transportFetch } from "../src/transport.ts";

// Notes (a retried setup GET, say): on the running test's meta, else on the
// file's, where src/reporter.ts finds them.
setCurrentTest(() => getCurrentTest());
// What each connection reset looked like, and which socket a fetch used (#1133).
const resets = watchResets();

// Every live fetch is bounded (src/fetch-timeout.ts), including the ones
// helpers and Backend's surface probes make with the global fetch. The bound
// covers both tries of a retried request. Inside it, a request that got no
// HTTP response is infra, never a verdict, and a safe one that failed on a
// reused socket is sent once more on a new connection (src/transport.ts).
globalThis.fetch = boundFetch(transportFetch(globalThis.fetch, resets));
// vitest parses the first argument as a fixture pattern; the file is second.
// biome-ignore lint/correctness/noEmptyPattern: required by vitest's fixture parser
afterAll(({}, file) => {
  const notes = [...takeFileNotes(), resets.totals()];
  if (notes.length)
    (file.meta as { redlineNotes?: string[] }).redlineNotes = notes;
});
