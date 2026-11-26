import { Blob as NodeBlob } from "node:buffer";
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useArtifact } from "../src/api/queries";
import { makeQueryClient } from "../src/api/queryClient";
import { useArtifactSideEffects } from "../src/viewer/useArtifactSideEffects";
import { installClock } from "./clock";
import { installHarness, server, wait } from "./harness";

installHarness();
installClock();

describe("stale thumbnail upload answered 409", () => {
  it("refetches the summary, logs nothing, does not retry, sends ?v=current", async () => {
    const base = fixtures.artifacts[0];
    const art = {
      ...base,
      id: "thumb409",
      access: "owner" as const,
      currentVersion: 3,
      thumbnailUrl: "/t?v=2",
      thumbnailVersion: 2,
    };
    const gets: string[] = [];
    const puts: URL[] = [];
    server.use(
      http.get(`*/api/v1/artifacts/${art.id}`, () => {
        gets.push(art.id);
        return HttpResponse.json(art);
      }),
      http.put(`*/api/v1/artifacts/${art.id}/thumbnail`, ({ request }) => {
        puts.push(new URL(request.url));
        return new HttpResponse(null, { status: 409 });
      }),
    );
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const qc = makeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        useArtifact(art.id);
        return useArtifactSideEffects(art, 3, () => true);
      },
      { wrapper },
    );
    await waitFor(() => expect(gets.length).toBe(1));
    result.current.onThumb(
      new NodeBlob([new Uint8Array(10)]) as unknown as Blob,
    );
    await waitFor(() => expect(gets.length).toBe(2));
    await wait(100);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.search).toBe("?v=3");
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });
});
