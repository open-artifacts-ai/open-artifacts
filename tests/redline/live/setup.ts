import { afterAll } from "vitest";
import { getCurrentTest } from "vitest/suite";
import { boundFetch } from "../src/fetch-timeout.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";

// Every live fetch is bounded (src/fetch-timeout.ts), including the ones
// helpers and Backend's surface probes make with the global fetch.
globalThis.fetch = boundFetch(globalThis.fetch);

// Notes (a retried setup GET, say): on the running test's meta, else on the
// file's, where src/reporter.ts finds them.
setCurrentTest(() => getCurrentTest());
// vitest parses the first argument as a fixture pattern; the file is second.
// biome-ignore lint/correctness/noEmptyPattern: required by vitest's fixture parser
afterAll(({}, file) => {
  const notes = takeFileNotes();
  if (notes.length)
    (file.meta as { redlineNotes?: string[] }).redlineNotes = notes;
});
