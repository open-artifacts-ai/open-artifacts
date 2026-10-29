// Presence client: the oa_pid cookie, usePresence's roster, and the stable
// onPresence that must not reconnect the events socket.
import type { PresenceEntry } from "@oa/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { presenceId } from "../src/viewer/presenceId";
import { useLiveVersions } from "../src/viewer/useLiveVersions";
import { usePresence } from "../src/viewer/usePresence";
import { arts, events, installHarness } from "./harness";

installHarness();

const clearCookie = () => {
  document.cookie = "oa_pid=; Max-Age=0; Path=/";
};
afterEach(clearCookie);

const entry = (key: string, name = key): PresenceEntry => ({
  key,
  kind: "person",
  name,
  named: true,
  color: 0,
});
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const C = "cccccccccccccccc";

describe("presenceId", () => {
  it("mints once and reuses the cookie", () => {
    clearCookie();
    const a = presenceId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(document.cookie).toContain(`oa_pid=${a}`);
    expect(presenceId()).toBe(a);
  });

  it("never reads or writes oa.anonId", () => {
    clearCookie();
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    localStorage.setItem("oa.anonId", "keep");
    set.mockClear();
    presenceId();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(localStorage.getItem("oa.anonId")).toBe("keep");
    get.mockRestore();
    set.mockRestore();
  });

  it("never throws when the cookie jar is blocked", () => {
    const d = vi.spyOn(document, "cookie", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => presenceId()).not.toThrow();
    expect(presenceId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    d.mockRestore();
  });
});

describe("usePresence", () => {
  const frame = (viewers: PresenceEntry[]) =>
    ({ type: "presence", viewers, total: viewers.length }) as const;

  it("hides you and keeps order", () => {
    const { result } = renderHook(() => usePresence());
    act(() =>
      result.current.onPresence(frame([entry(B), entry(A), entry(C)]), A),
    );
    expect(result.current.others.map((e) => e.key)).toEqual([B, C]);
    expect(result.current.total).toBe(3);
  });

  it("keeps everyone when you is unknown", () => {
    const { result } = renderHook(() => usePresence());
    act(() =>
      result.current.onPresence(frame([entry(B), entry(A)]), undefined),
    );
    expect(result.current.others.map((e) => e.key)).toEqual([B, A]);
  });
});

const PID = arts[0]?.id as string;
const Probe = ({
  onRender,
}: {
  onRender: (p: ReturnType<typeof usePresence>) => void;
}) => {
  const p = usePresence();
  onRender(p);
  useLiveVersions({
    id: PID,
    data: undefined,
    explicit: undefined,
    chromeless: false,
    embed: false,
    frame: () => ({ hello: false, touched: true, engaged: false }),
    chromeOpen: () => false,
    onPresence: (f, you) => p.onPresence(f, you),
  });
  return null;
};
const qc = makeQueryClient();
const probe = (onRender: (p: ReturnType<typeof usePresence>) => void) => (
  <QueryClientProvider client={qc}>
    <Probe onRender={onRender} />
  </QueryClientProvider>
);
const mountProbe = (onRender: (p: ReturnType<typeof usePresence>) => void) =>
  render(probe(onRender));

describe("usePresence on the live socket", () => {
  it("a gone artifact clears the roster", async () => {
    let last: ReturnType<typeof usePresence> | undefined;
    mountProbe((p) => {
      last = p;
    });
    await waitFor(() => expect(events.connections(PID)).toBe(1));
    act(() => {
      events.emitPresence(PID, [entry(A), entry(B)], A);
    });
    await waitFor(() => expect(last?.total).toBe(2));
    expect(last?.others.map((e) => e.key)).toEqual([A, B]);
    act(() => {
      events.emitGone(PID, "deleted");
    });
    await waitFor(() => expect(last?.total).toBe(0));
    expect(last?.others).toEqual([]);
  });

  it("a new onPresence identity does not reconnect the socket", async () => {
    const calls: unknown[] = [];
    const { rerender } = mountProbe((p) => calls.push(p.onPresence));
    const first = calls.length;
    await waitFor(() => expect(events.connections(PID)).toBe(1));
    act(() => {
      events.emitPresence(PID, [entry(B)], A);
    });
    rerender(probe((p) => calls.push(p.onPresence)));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(events.connections(PID)).toBe(1);
    expect(calls.length).toBeGreaterThan(first);
    expect(new Set(calls).size).toBe(1);
  });
});
