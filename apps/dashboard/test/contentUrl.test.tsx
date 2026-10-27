import { R } from "@oa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefetchContentUrl, useContentUrl } from "../src/viewer/useContentUrl";

let n = 0;
let expiry: string | null;
/** The version a version-less request serves. */
let current = 1;
let fetchMock: ReturnType<typeof vi.fn>;
const wrap = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => {
  n = 0;
  current = 1;
  fetchMock = vi.fn(
    async (u: string) =>
      new Response(
        JSON.stringify({
          url: `https://c.test/u${++n}`,
          expiresAt: expiry,
          version:
            Number(new URL(u, "http://x").searchParams.get("v")) || current,
        }),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useContentUrl", () => {
  it("fetches R.contentUrl", async () => {
    expiry = null;
    const { result } = renderHook(() => useContentUrl("a1", 3), {
      wrapper: wrap,
    });
    await waitFor(() => expect(result.current.url).toBe("https://c.test/u1"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(R.contentUrl("a1", 3));
  });

  const mount = async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const r = renderHook(() => useContentUrl("a1", 1), { wrapper: wrap });
    await act(() => vi.advanceTimersByTimeAsync(0));
    return r;
  };

  it("null expiry never refreshes", async () => {
    expiry = null;
    const { result } = await mount();
    expect(result.current.url).toBe("https://c.test/u1");
    await act(() => vi.advanceTimersByTimeAsync(3_600_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches 60s before expiry; src freezes once loaded", async () => {
    expiry = new Date(Date.now() + 10 * 60_000).toISOString();
    const { result } = await mount();
    expect(result.current.url).toBe("https://c.test/u1");
    await act(() => vi.advanceTimersByTimeAsync(9 * 60_000 - 1000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe("https://c.test/u2");
    act(() => result.current.onLoad());
    await act(() => vi.advanceTimersByTimeAsync(9 * 60_000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    expect(result.current.url).toBe("https://c.test/u2");
  });

  it("unparseable expiresAt does not hot-loop", async () => {
    expiry = "soon";
    await mount();
    await act(() => vi.advanceTimersByTimeAsync(14_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores client clock skew when scheduling refresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    expiry = new Date(Date.now() - 20 * 60_000 + 600_000).toISOString();
    renderHook(() => useContentUrl("a1", 1), { wrapper: wrap });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(480_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adopts the early fetch when it serves the version shown (#693)", async () => {
    expiry = null;
    current = 4;
    prefetchContentUrl("a1");
    const { result } = renderHook(() => useContentUrl("a1", 4), {
      wrapper: wrap,
    });
    await waitFor(() => expect(result.current.url).toBe("https://c.test/u1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(R.contentUrl("a1"));
  });

  it("fetches again when the early fetch served another version", async () => {
    expiry = null;
    current = 5;
    prefetchContentUrl("a1");
    const { result } = renderHook(() => useContentUrl("a1", 4), {
      wrapper: wrap,
    });
    await waitFor(() => expect(result.current.url).toBe("https://c.test/u2"));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(R.contentUrl("a1", 4));
  });

  it("ignores an early fetch for another artifact, or one that failed", async () => {
    expiry = null;
    prefetchContentUrl("other");
    const a = renderHook(() => useContentUrl("a1", 1), { wrapper: wrap });
    await waitFor(() => expect(a.result.current.url).not.toBeNull());
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(R.contentUrl("a1", 1));
    fetchMock.mockImplementationOnce(
      async () => new Response("", { status: 500 }),
    );
    prefetchContentUrl("a2");
    const b = renderHook(() => useContentUrl("a2", 1), { wrapper: wrap });
    await waitFor(() => expect(b.result.current.url).not.toBeNull());
    expect(b.result.current.error).toBeNull();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(R.contentUrl("a2", 1));
  });

  it("a stale early fetch (over 10 s) is not used", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    expiry = null;
    prefetchContentUrl("a1");
    await act(() => vi.advanceTimersByTimeAsync(10_001));
    renderHook(() => useContentUrl("a1", 1), { wrapper: wrap });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
