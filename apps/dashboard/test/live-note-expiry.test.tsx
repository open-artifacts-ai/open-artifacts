// The "Updated to vN" note expires after NOTE_MS. A newer swap can land just
// as the older note's timer fires, before React unmounts that note: the old
// timer must not clear the new note (the row 52 e2e flake on WebKit).
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOTE_MS, TitleLive } from "../src/viewer/LiveChip";
import { expireSwapped, type Swapped } from "../src/viewer/useLiveVersions";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

let swap: (s: Swapped) => void = () => {};
function Slot() {
  const [swapped, setSwapped] = useState<Swapped | null>({
    version: 2,
    prev: 1,
  });
  swap = setSwapped;
  return (
    <TitleLive
      held={null}
      swapped={swapped}
      current={null}
      onView={() => {}}
      onCurrent={() => {}}
      onExpire={(v) => setSwapped((s) => expireSwapped(s, v))}
    />
  );
}

it("v3 swaps in as v2's note expires: the v3 note stays for its own NOTE_MS", () => {
  render(<Slot />);
  expect(screen.getByText("Updated to v2")).toBeTruthy();
  act(() => vi.advanceTimersByTime(NOTE_MS - 1));
  // One batch: v3's swap is set, then v2's timer fires before the commit.
  act(() => {
    swap({ version: 3, prev: 2 });
    vi.advanceTimersByTime(1);
  });
  expect(screen.getByText("Updated to v3")).toBeTruthy();
  act(() => vi.advanceTimersByTime(NOTE_MS - 1));
  expect(screen.getByText("Updated to v3")).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText(/Updated to v/)).toBeNull();
});

it("expireSwapped clears only the note that expired", () => {
  const v3: Swapped = { version: 3, prev: 2 };
  expect(expireSwapped(v3, 2)).toBe(v3);
  expect(expireSwapped(v3, 3)).toBeNull();
  expect(expireSwapped(null, 3)).toBeNull();
});
