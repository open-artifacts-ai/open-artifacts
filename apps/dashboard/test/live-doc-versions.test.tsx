// #2750, #2751: a doc open in the live editor is always current. The room
// shows every edit, so a newer saved version (the doc's own autosave) never
// offers "new version available", and no layer for it is preloaded (which
// greyed the screen on View).
import { R, viewerPath } from "@oa/shared";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setMockDoc } from "../src/viewer/doc/docMock";
import { installClock, settle } from "./clock";
import { arts, events, installHarness, mount } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));
vi.mock("../src/viewer/doc/DocEditor", async (orig) => ({
  ...(await orig<typeof import("../src/viewer/doc/DocEditor")>()),
  DocEditor: () => <div data-testid="doc-editor" />,
}));

installHarness();
installClock();

const DOC = (arts.find((a) => a.title === "Landing page") as { id: string }).id;
setMockDoc(DOC);

describe("a doc in the live editor", () => {
  it("never offers a newer version (its own autosave), and never preloads a layer", async () => {
    mount(viewerPath(DOC));
    await screen.findByTestId("doc-editor");
    await waitFor(() => expect(events.connections(DOC)).toBe(1));
    await act(() =>
      fetch(R.restoreVersion(DOC, 1), {
        method: "POST",
        headers: { "X-OA-Request": "1" },
      }),
    );
    // Past the 1 s debounce.
    await settle(1_500);
    expect(screen.queryByRole("button", { name: /^View version/ })).toBeNull();
    expect(document.querySelectorAll(".oa-vlayer")).toHaveLength(1);
    expect(screen.queryByText(/new version/i)).toBeNull();
  });
});
