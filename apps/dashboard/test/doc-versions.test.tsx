// #1100: a doc's versions in the Versions panel. Save version (a named save),
// the automatic versions' labels, restore through the room with no confirm
// (PROVISIONAL routes, mocked), and other artifacts unchanged.
import { type VersionInfo, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { setMockDoc } from "../src/viewer/doc/docMock";
import {
  docSaveKind,
  docVersionLabel,
  restoredToast,
  savedToast,
} from "../src/viewer/doc/versions";
import { calls, findVisibleToast, installHarness, mount } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));
// The live editor is not under test here: no room to connect to.
vi.mock("../src/viewer/doc/DocEditor", async (orig) => ({
  ...(await orig<typeof import("../src/viewer/doc/DocEditor")>()),
  DocEditor: () => <div data-testid="doc-editor" />,
}));

const byTitle = (t: string) =>
  fixtures.artifacts.find((a) => a.title === t) as {
    id: string;
    currentVersion: number;
  };
const DOC = byTitle("Landing page");
const OTHER = byTitle("Parser script");

// The doc's history as the room saves it (seeded before the harness copies
// the fixtures for each test).
const base = fixtures.versions[DOC.id]?.[0] as VersionInfo;
const ada = base.createdBy;
const duck = {
  name: "OA Product",
  version: "1.0",
  linked: true,
  product: "Claude Code",
  animal: { id: "duck", color: 6 },
};
const v = (
  version: number,
  message: string | null,
  saveKind: VersionInfo["saveKind"],
  agent: typeof duck | null = null,
): VersionInfo => ({
  ...structuredClone(base),
  version,
  message,
  ...(saveKind ? { saveKind } : {}),
  agent,
  createdBy: ada,
});
const savedVersions = fixtures.versions[DOC.id];
const savedCurrent = DOC.currentVersion;
fixtures.versions[DOC.id] = [
  v(5, "Restored v2", "restored"),
  v(4, null, "before_agent"),
  v(3, null, "auto", duck),
  v(2, "After review", "named"),
  v(1, "First draft", undefined),
];
DOC.currentVersion = 5;
setMockDoc(DOC.id);
afterAll(() => {
  fixtures.versions[DOC.id] = savedVersions ?? [];
  DOC.currentVersion = savedCurrent;
  setMockDoc(null);
});

installHarness();

const panel = (id: string, ver?: number) =>
  `${viewerPath(id, ver)}?panel=open&tab=versions`;
const list = () => screen.findByRole("list", { name: "Versions" });
const row = async (n: number) =>
  within(await list()).getByRole("button", { name: new RegExp(`^v${n}, `) });

describe("doc version kinds and labels", () => {
  it("uses the server's saveKind, else reads the message", () => {
    expect(docSaveKind(v(1, null, "before_agent"))).toBe("before_agent");
    expect(docSaveKind(v(1, null, undefined))).toBe("auto");
    expect(docSaveKind(v(1, "Restored v3", undefined))).toBe("restored");
    expect(docSaveKind(v(1, "Before launch", undefined))).toBe("named");
    expect(docVersionLabel(v(1, null, "auto"))).toBe("Saved automatically");
    // Until the lead's string comes, the save before an agent edit reads as automatic.
    expect(docVersionLabel(v(1, null, "before_agent"))).toBe(
      "Saved automatically",
    );
    expect(docVersionLabel(v(1, "Before launch", "named"))).toBe(
      "Before launch",
    );
  });

  it("the mockup's toasts", () => {
    expect(savedToast("Before launch", 7)).toBe('Saved "Before launch" as v7.');
    // The room saves unsaved edits first: the doc as it was is the version before.
    expect(restoredToast(3, 8)).toBe(
      "Restored v3. Nothing is lost: the doc as it was is kept as v7.",
    );
  });
});

describe("a doc's Versions panel", () => {
  it("labels each version by how it was saved; an agent's row has its face", async () => {
    mount(panel(DOC.id));
    expect(await row(5)).toHaveTextContent("Restored v2");
    expect(await row(4)).toHaveTextContent("Saved automatically");
    const agent = await row(3);
    expect(agent).toHaveTextContent("Saved automatically");
    expect(agent).toHaveTextContent("OA Product");
    expect(
      agent.querySelector('[data-avatar="agent"][data-animal="duck"]'),
    ).not.toBeNull();
    expect(await row(2)).toHaveTextContent("After review");
    // No saveKind (an older server): a name reads as a name.
    expect(await row(1)).toHaveTextContent("First draft");
    expect(
      screen.getByText(
        "Pick a version to compare it with the doc as it is now. Restore makes a new version, so nothing is lost.",
      ),
    ).toBeVisible();
  });

  it("Save version posts the name to the doc route and says so", async () => {
    mount(panel(DOC.id));
    const posts = calls("POST");
    const name = await screen.findByRole("textbox", { name: "Version name" });
    fireEvent.change(name, { target: { value: "  Before launch " } });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await findVisibleToast('Saved "Before launch" as v6.');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(`/api/v1/artifacts/${DOC.id}/doc/versions`);
    await waitFor(() =>
      expect(posts[0]?.body).toEqual({ name: "Before launch" }),
    );
    expect(await row(6)).toHaveTextContent("Before launch");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Version name" })).toHaveValue(
        "",
      ),
    );
  });

  it("Save version with no name lets the server name it", async () => {
    mount(panel(DOC.id));
    const posts = calls("POST");
    fireEvent.click(
      await screen.findByRole("button", { name: "Save version" }),
    );
    await findVisibleToast('Saved "Version 6" as v6.');
    await waitFor(() => expect(posts[0]?.body).toEqual({}));
  });

  it("a double click saves once", async () => {
    mount(panel(DOC.id));
    const posts = calls("POST");
    const b = await screen.findByRole("button", { name: "Save version" });
    fireEvent.click(b);
    fireEvent.click(b);
    await findVisibleToast('Saved "Version 6" as v6.');
    expect(posts).toHaveLength(1);
  });

  it("Restore goes through the room with no confirm, says nothing is lost, and returns to the live doc", async () => {
    const router = mount(panel(DOC.id, 2));
    const posts = calls("POST");
    // The older version shows what was saved, not the live editor.
    await screen.findByText(/You're viewing/);
    expect(screen.queryByTestId("doc-editor")).toBeNull();
    const restore = within(
      (await row(2)).closest("li") as HTMLElement,
    ).getByRole("button", { name: "Restore" });
    fireEvent.click(restore);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await findVisibleToast(
      "Restored v2. Nothing is lost: the doc as it was is kept as v5.",
    );
    expect(posts.map((c) => c.path)).toEqual([
      `/api/v1/artifacts/${DOC.id}/doc/versions/2/restore`,
    ]);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(DOC.id)),
    );
    expect(await screen.findByTestId("doc-editor")).toBeInTheDocument();
  });

  it("the older-version banner's Restore also goes through the room", async () => {
    mount(viewerPath(DOC.id, 3));
    const posts = calls("POST");
    fireEvent.click(
      await screen.findByRole("button", { name: "Restore this version" }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await findVisibleToast(
      "Restored v3. Nothing is lost: the doc as it was is kept as v5.",
    );
    expect(posts.map((c) => c.path)).toEqual([
      `/api/v1/artifacts/${DOC.id}/doc/versions/3/restore`,
    ]);
  });
});

describe("other artifacts", () => {
  it("have no Save version, and Restore still asks first", async () => {
    mount(panel(OTHER.id, 24));
    await screen.findByRole("list", { name: "Versions" });
    expect(screen.queryByRole("button", { name: "Save version" })).toBeNull();
    const restore = within(
      (await row(24)).closest("li") as HTMLElement,
    ).getByRole("button", { name: "Restore" });
    fireEvent.click(restore);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "This publishes a new version with the contents of the selected one.",
    );
  });
});
