// Viewer presence client (#949 Task 7): the oa_pid session cookie, and
// usePresence on the events socket through the R.events mock.
import {
  PRESENCE_COOKIE,
  PRESENCE_ID_RE,
  type PresenceEntry,
  type PresenceFrame,
} from "@oa/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANON_ID_KEY } from "../src/viewer/anonId";
import { presenceId } from "../src/viewer/presenceId";
import { useLiveVersions } from "../src/viewer/useLiveVersions";
import { usePresence } from "../src/viewer/usePresence";
import { arts, events, installHarness, wrapper } from "./harness";

installHarness();

const clearCookie = () => {
  // biome-ignore lint/suspicious/noDocumentCookie: test cleanup
  document.cookie = `${PRESENCE_COOKIE}=; Path=/; Max-Age=0`;
};
afterEach(clearCookie);

const ID = (arts.find((a) => a.title === "Landing page") as { id: string }).id;
const face = (key: string, name: string): PresenceEntry => ({
  key,
  kind: "person",
  name,
  named: true,
  color: 0,
});
const A = face("AAAAAAAAAAAAAAAA", "Ada");
const B = face("BBBBBBBBBBBBBBBB", "Bo");
const ME = face("CCCCCCCCCCCCCCCC", "Me");

const live = (onPresence: (f: PresenceFrame, you?: string) => void) =>
  ({
    id: ID,
    data: undefined,
    explicit: undefined,
    chromeless: false,
    embed: false,
    frame: () => ({ hello: false, touched: true, engaged: false }),
    chromeOpen: () => false,
    onPresence,
  }) as Parameters<typeof useLiveVersions>[0];

describe("presenceId", () => {
  it("mints once and reuses the cookie", () => {
    clearCookie();
    const a = presenceId();
    expect(a).toMatch(PRESENCE_ID_RE);
    expect(a).toHaveLength(22);
    expect(document.cookie).toContain(`${PRESENCE_COOKIE}=${a}`);
    expect(presenceId()).toBe(a);
  });

  it("never reads or writes oa.anonId", () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    localStorage.setItem(ANON_ID_KEY, "x");
    set.mockClear();
    const id = presenceId();
    expect(get).not.toHaveBeenCalledWith(ANON_ID_KEY);
    expect(set).not.toHaveBeenCalled();
    expect(id).not.toContain("x".repeat(3));
    expect(document.cookie).not.toContain("oa.anonId");
    get.mockRestore();
    set.mockRestore();
  });

  it("never throws when cookies are unavailable", () => {
    const d = vi.spyOn(document, "cookie", "get").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => presenceId()).not.toThrow();
    d.mockRestore();
  });
});

describe("usePresence", () => {
  const setup = () => {
    const h = renderHook(
      () => {
        const p = usePresence();
        useLiveVersions(live(p.onPresence));
        return p;
      },
      { wrapper },
    );
    return h;
  };

  it("hides you and keeps order", async () => {
    events.presenceYou = () => ME.key;
    const h = setup();
    await waitFor(() => expect(events.connections(ID)).toBe(1));
    act(() => {
      events.emitPresence(ID, [B, ME, A], ME.key);
    });
    await waitFor(() => expect(h.result.current.total).toBe(3));
    expect(h.result.current.others.map((e) => e.name)).toEqual(["Bo", "Ada"]);
  });

  it("a gone artifact clears the roster", async () => {
    const h = setup();
    await waitFor(() => expect(events.connections(ID)).toBe(1));
    act(() => {
      events.emitPresence(ID, [A, B], undefined);
    });
    await waitFor(() => expect(h.result.current.others).toHaveLength(2));
    act(() => {
      events.emitGone(ID);
    });
    await waitFor(() => expect(h.result.current.others).toEqual([]));
    expect(h.result.current.total).toBe(0);
  });

  it("a new onPresence identity does not reconnect the socket", async () => {
    const Real = globalThis.WebSocket;
    let opened = 0;
    vi.stubGlobal(
      "WebSocket",
      class extends Real {
        constructor(...a: ConstructorParameters<typeof Real>) {
          opened++;
          super(...a);
        }
      },
    );
    const h = renderHook(
      ({ cb }: { cb: () => void }) => useLiveVersions(live(cb)),
      { wrapper, initialProps: { cb: (() => {}) as () => void } },
    );
    await waitFor(() => expect(events.connections(ID)).toBe(1));
    expect(opened).toBe(1);
    h.rerender({ cb: () => {} });
    h.rerender({ cb: () => {} });
    await act(async () => {});
    expect(opened).toBe(1);
  });
});
