// The smoke search test's wait for a body word to become searchable, as a
// function of its seams so a unit test can drive it on a fake clock and fake
// asks: one budget covers every hold, every body read and the search, and an
// answer that arrives after it is refused, whatever it says.

/** A response already read in full: the body is in memory, so reading it takes no time. */
export type Answer = { status: number; text: string };

export type FindIndexed = {
  /** One held ask of GET versions (`wait` ms), cut off when `signal` aborts. */
  versions: (wait: number, signal: AbortSignal) => Promise<Answer>;
  /** The search for the body word, cut off when `signal` aborts. */
  search: (signal: AbortSignal) => Promise<Answer>;
  /** Whether the newest version in a 200 versions body is text-indexed. */
  indexed: (text: string) => boolean;
  /** Whether the search body lists the artifact. */
  listed: (text: string) => boolean;
  /** The whole bound, from the first ask to the search's answer. */
  budgetMs: number;
  /** The most one hold asks for. */
  holdMs: number;
  /** Quick "not indexed" answers in a row before the install is judged not to hold. */
  quickMax: number;
  now?: () => number;
  signalFor?: (ms: number) => AbortSignal;
};

const defaultSignalFor = (ms: number): AbortSignal => AbortSignal.timeout(ms);

export async function findIndexed(o: FindIndexed): Promise<void> {
  const now = o.now ?? Date.now;
  const signalFor = o.signalFor ?? defaultSignalFor;
  const end = now() + o.budgetMs;
  const within = async <T>(
    left: number,
    run: (signal: AbortSignal) => Promise<T>,
    what: string,
  ): Promise<T> => {
    const signal = signalFor(left);
    const cut = new Promise<never>((_, reject) =>
      signal.addEventListener(
        "abort",
        () =>
          reject(
            new Error(`${what}: no answer within the ${o.budgetMs} ms budget`),
          ),
        { once: true },
      ),
    );
    const r = await Promise.race([run(signal), cut]);
    if (now() > end)
      throw new Error(`${what}: answered after the ${o.budgetMs} ms budget`);
    return r;
  };
  let quick = 0;
  for (;;) {
    const left = end - now();
    if (left <= 0) throw new Error(`not indexed within ${o.budgetMs} ms`);
    const hold = Math.min(left, o.holdMs);
    const asked = now();
    const v = await within(left, (s) => o.versions(hold, s), "versions");
    if (v.status !== 200) throw new Error(`versions: ${v.status} ${v.text}`);
    if (o.indexed(v.text)) break;
    quick = now() - asked < hold / 2 ? quick + 1 : 0;
    if (quick > o.quickMax)
      throw new Error(
        "versions?wait answers without holding: an install without the wait param",
      );
  }
  const left = end - now();
  if (left <= 0)
    throw new Error(`searched too late: the ${o.budgetMs} ms budget is spent`);
  const s = await within(left, (sig) => o.search(sig), "search");
  if (s.status !== 200) throw new Error(`search: ${s.status} ${s.text}`);
  if (!o.listed(s.text))
    throw new Error(`search: the artifact is not listed: ${s.text}`);
}
