// cloud #291: a reply made after the viewer fetched the comments list but
// before its events socket joined sends its `comments` frame to no one. Every
// hello refetches the list, so that reply still shows without a reload.
// #3095: a frame that lands while the list's first fetch is still in flight
// must not join that fetch (its answer predates the reply): it refetches.
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { refetchesComments, refetchNow } from "../src/viewer/useLiveVersions";

it("a comments frame and every hello refetch the comments list", () => {
  expect(refetchesComments({ type: "comments" })).toBe(true);
  expect(refetchesComments({ type: "hello" })).toBe(true);
});

it("version, presence and gone frames leave the comments list alone", () => {
  for (const type of ["version", "presence", "gone"])
    expect(refetchesComments({ type })).toBe(false);
});

/** A watched query whose fetches the test answers, in order. */
const watched = (qc: QueryClient) => {
  const answers: Array<(v: string[]) => void> = [];
  const obs = new QueryObserver<string[]>(qc, {
    queryKey: ["comments", "a1"],
    queryFn: () => new Promise<string[]>((r) => answers.push(r)),
  });
  const off = obs.subscribe(() => {});
  return { answers, off };
};

it("a frame during the first fetch refetches: the reply it announces shows (#3095)", async () => {
  const qc = new QueryClient();
  const { answers, off } = watched(qc);
  expect(answers).toHaveLength(1); // the first fetch, still in flight
  const done = refetchNow(qc, ["comments"]);
  // A fetch that started after the frame, not the one before it.
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  answers[0]?.(["Watching"]); // the first fetch's late answer, from before the reply
  answers[1]?.(["Watching", "Arrived while you were reading"]);
  await done;
  expect(qc.getQueryData(["comments", "a1"])).toEqual([
    "Watching",
    "Arrived while you were reading",
  ]);
  off();
});

it("a frame during a refetch, with a list shown, still refetches once more", async () => {
  const qc = new QueryClient();
  const { answers, off } = watched(qc);
  answers[0]?.(["Watching"]);
  await vi.waitFor(() =>
    expect(qc.getQueryData(["comments", "a1"])).toEqual(["Watching"]),
  );
  void qc.invalidateQueries({ queryKey: ["comments"] });
  expect(answers).toHaveLength(2);
  const done = refetchNow(qc, ["comments"]);
  await vi.waitFor(() => expect(answers).toHaveLength(3));
  answers[1]?.(["Watching"]);
  answers[2]?.(["Watching", "A reply"]);
  await done;
  expect(qc.getQueryData(["comments", "a1"])).toEqual(["Watching", "A reply"]);
  off();
});

it("a frame with nothing in flight refetches once", async () => {
  const qc = new QueryClient();
  const { answers, off } = watched(qc);
  answers[0]?.(["Watching"]);
  await vi.waitFor(() =>
    expect(qc.getQueryData(["comments", "a1"])).toEqual(["Watching"]),
  );
  const done = refetchNow(qc, ["comments"]);
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  answers[1]?.(["Watching", "A reply"]);
  await done;
  expect(answers).toHaveLength(2);
  expect(qc.getQueryData(["comments", "a1"])).toEqual(["Watching", "A reply"]);
  off();
});
