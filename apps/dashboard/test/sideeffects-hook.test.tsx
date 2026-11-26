import type { ArtifactSummary } from "@oa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { installClock } from "./clock";

const getMock = vi.fn();
const putBody = vi.fn(async () => {});
vi.mock("../src/api/client", async (orig) => {
  const m = await orig<typeof import("../src/api/client")>();
  return {
    ...m,
    api: { ...m.api, get: (...a: unknown[]) => getMock(...a), putBody },
  };
});

const { useArtifactSideEffects } = await import(
  "../src/viewer/useArtifactSideEffects"
);

let n = 0;
const art = (o: Partial<ArtifactSummary> = {}) =>
  ({
    id: `adv${++n}`,
    format: "html",
    currentVersion: 1,
    thumbnailUrl: null,
    access: "editor",
    capabilities: { db: true, viewer: true, storage: false },
    ...o,
  }) as unknown as ArtifactSummary;
installClock();
// Zero-delay turn on the fake clock: queued promise work and 0 ms timers run.
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("side-effects hook", () => {
  it("text that arrives before version info loads is still sent once info lands", async () => {
    const a = art({ format: "pdf" });
    let resolve!: (v: unknown) => void;
    getMock.mockImplementation(() => new Promise((r) => (resolve = r)));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useArtifactSideEffects(a, 1, () => true),
      { wrapper },
    );
    act(() => result.current.onPdfText("hello"));
    await act(async () => {
      resolve([
        {
          version: 1,
          message: null,
          agent: null,
          createdBy: { id: "u", name: "u", avatarUrl: null },
          createdAt: "t",
          entry: "a.pdf",
          files: [],
          language: null,
          textIndexed: false,
          format: "pdf",
        },
      ]);
      await flush();
    });
    await waitFor(() => expect(putBody).toHaveBeenCalledTimes(1), {
      timeout: 500,
    });
  });
});
