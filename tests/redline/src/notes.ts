// Notes a live case's report carries without changing its level, e.g. "GET
// /api/v1/me retried once (ECONNRESET)". Inside a test the note goes on its
// task meta (redlineNotes); outside one (beforeAll, module setup) it is kept
// for the file, and live/setup.ts's afterAll puts it on the file's meta.
// src/reporter.ts prints both. No vitest import here (plain-node scripts load
// these helpers): live/setup.ts installs the current-test lookup.

type Task = { meta: object };
let currentTest: () => Task | undefined = () => undefined;
const fileNotes: string[] = [];

/** live/setup.ts: how to find the running test (vitest/suite getCurrentTest). */
export function setCurrentTest(f: () => Task | undefined): void {
  currentTest = f;
}

/** Records `text` on the running test, or on the file when none is running. */
export function note(text: string): void {
  const t = currentTest();
  if (t) {
    const m = t.meta as { redlineNotes?: string[] };
    m.redlineNotes ??= [];
    m.redlineNotes.push(text);
  } else fileNotes.push(text);
}

/** The file-level notes so far, emptied. */
export const takeFileNotes = (): string[] => fileNotes.splice(0);
