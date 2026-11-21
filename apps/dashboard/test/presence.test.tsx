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
import { connectArtifactEvents } from "../src/viewer/liveEvents";
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

  describe("cookie attributes", () => {
    const written = (protocol: string) => {
      clearCookie();
      vi.stubGlobal("location", { protocol, host: "app.test" });
      const get = vi.spyOn(document, "cookie", "get").mockReturnValue("");
      const set = vi
        .spyOn(document, "cookie", "set")
        .mockImplementation(() => {});
      presenceId();
      const v = set.mock.calls[0]?.[0] as string;
      get.mockRestore();
      set.mockRestore();
      vi.unstubAllGlobals();
      return v;
    };
    it("is a session cookie on / with SameSite=Lax", () => {
      const v = written("http:");
      expect(v).toMatch(/^oa_pid=[A-Za-z0-9_-]{22}; Path=\/; SameSite=Lax$/);
      expect(v).not.toMatch(/Max-Age|Expires/i);
    });
    it("adds Secure only on https", () => {
      expect(written("https:")).toMatch(/; Secure$/);
      expect(written("http:")).not.toMatch(/Secure/);
    });
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
    await waitFor(() => expect(h.result.current.total).toBe(2));
    expect(h.result.current.others.map((e) => e.name)).toEqual(["Bo", "Ada"]);
    // The server's total counts the caller; ours counts others.
    expect(h.result.current.total).toBe(2);
  });

  it("total counts others: self is subtracted whether or not the cap cut it", () => {
    const h = renderHook(() => usePresence());
    act(() =>
      h.result.current.onPresence(
        { type: "presence", viewers: [A, ME, B], total: 3 },
        ME.key,
      ),
    );
    expect(h.result.current.total).toBe(2);
    // Over the cap, self was cut from the list: the server's total (150) still counts it.
    act(() =>
      h.result.current.onPresence(
        { type: "presence", viewers: [A, B], total: 150 },
        ME.key,
      ),
    );
    expect(h.result.current.total).toBe(149);
    expect(h.result.current.others).toHaveLength(2);
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
    vi.useFakeTimers();
    try {
      h.rerender({ cb: () => {} });
      h.rerender({ cb: () => {} });
      // A re-run connect effect opens its socket in setTimeout(open, 0).
      vi.advanceTimersByTime(10);
    } finally {
      vi.useRealTimers();
    }
    expect(opened).toBe(1);
  });
});

describe("cookie before connect", () => {
  const connect = (embed: boolean) => {
    const order: string[] = [];
    vi.useFakeTimers();
    vi.stubGlobal(
      "WebSocket",
      class {
        static CONNECTING = 0;
        static OPEN = 1;
        readyState = 0;
        constructor() {
          order.push("socket");
        }
        close() {}
      },
    );
    vi.spyOn(document, "cookie", "get").mockReturnValue("");
    const set = vi.spyOn(document, "cookie", "set").mockImplementation(() => {
      order.push("cookie");
    });
    const c = connectArtifactEvents({
      id: "abc",
      embed,
      onEvent() {},
      onGone() {},
      onDown() {},
    });
    vi.advanceTimersByTime(0);
    c.close();
    set.mockRestore();
    vi.useRealTimers();
    return order;
  };
  it("sets the cookie before the first socket exists", () => {
    expect(connect(false)).toEqual(["cookie", "socket"]);
  });
  it("embed mode never touches it", () => {
    expect(connect(true)).toEqual(["socket"]);
  });
});
