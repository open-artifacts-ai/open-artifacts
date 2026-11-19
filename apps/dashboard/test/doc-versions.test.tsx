// #1100: a doc's versions in the Versions panel. Save version (a named save),
// the automatic versions' labels, restore through the room with no confirm
// (PROVISIONAL routes, mocked), and other artifacts unchanged.
import { type VersionInfo, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, describe, expect, it, vi } from "vitest";
import { setMockDoc } from "../src/viewer/doc/docMock";
import {
  docSaveKind,
  docVersionLabel,
  restoredToast,
} from "../src/viewer/doc/versions";
import {
  calls,
  findVisibleToast,
  installHarness,
  mount,
  server,
} from "./harness";

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
  kind: NonNullable<VersionInfo["docSave"]>["kind"] | undefined,
  agent: typeof duck | null = null,
  by?: NonNullable<VersionInfo["docSave"]>["by"],
): VersionInfo => ({
  ...structuredClone(base),
  version,
  message,
  ...(kind ? { docSave: { kind, ...(by ? { by } : {}) } } : {}),
  agent,
  createdBy: ada,
});
const savedVersions = fixtures.versions[DOC.id];
const savedCurrent = DOC.currentVersion;
fixtures.versions[DOC.id] = [
  v(5, "Restored v2", "restore"),
  v(4, null, "before_agent", null, duck),
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
  it("uses Backend's docSave marker, else reads the message", () => {
    expect(docSaveKind(v(1, null, "before_agent"))).toBe("before_agent");
    expect(docSaveKind(v(1, null, undefined))).toBe("auto");
    expect(docSaveKind(v(1, "Restored v3", undefined))).toBe("restore");
    expect(docSaveKind(v(1, "Before launch", undefined))).toBe("named");
    expect(docVersionLabel(v(1, null, "auto"))).toBe("Saved automatically");
    // Product: the save before an agent edits names that agent, if known.
    expect(docVersionLabel(v(1, null, "before_agent", null, duck))).toBe(
      "Before OA Product edited",
    );
    expect(docVersionLabel(v(1, null, "before_agent"))).toBe(
      "Before an agent edited",
    );
    // A person in `by` is not an agent's name.
    expect(docVersionLabel(v(1, null, "before_agent", null, ada))).toBe(
      "Before an agent edited",
    );
    expect(docVersionLabel(v(1, "Before launch", "named"))).toBe(
      "Before launch",
    );
  });

  it("the mockup's restore toast", () => {
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
    expect(await row(4)).toHaveTextContent("Before OA Product edited");
    const agent = await row(3);
    expect(agent).toHaveTextContent("Saved automatically");
    expect(agent).toHaveTextContent("OA Product");
    expect(
      agent.querySelector('[data-avatar="agent"][data-animal="duck"]'),
    ).not.toBeNull();
    expect(await row(2)).toHaveTextContent("After review");
    // No marker (a server without it yet): a name reads as a name.
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
    await findVisibleToast("Version saved.");
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
    await findVisibleToast("Version saved.");
    await waitFor(() => expect(posts[0]?.body).toEqual({}));
  });

  it("a failed save says Product's words, whatever the server said, and keeps the name", async () => {
    server.use(
      http.post(`*/api/v1/artifacts/${DOC.id}/doc/versions`, () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Room down" } },
          { status: 500 },
        ),
      ),
    );
    mount(panel(DOC.id));
    const name = await screen.findByRole("textbox", { name: "Version name" });
    fireEvent.change(name, { target: { value: "Before launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await findVisibleToast("Couldn't save a version. Try again.");
    expect(name).toHaveValue("Before launch");
  });

  it("a double click saves once", async () => {
    mount(panel(DOC.id));
    const posts = calls("POST");
    const b = await screen.findByRole("button", { name: "Save version" });
    fireEvent.click(b);
    fireEvent.click(b);
    await findVisibleToast("Version saved.");
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

describe("a reader of a doc", () => {
  it("has no Save version and no Restore", async () => {
    setMockDoc(DOC.id, true);
    try {
      mount(panel(DOC.id, 3));
      await screen.findByRole("list", { name: "Versions" });
      expect(screen.queryByRole("button", { name: "Save version" })).toBeNull();
      await row(3);
      expect(
        screen.queryByRole("button", { name: "Restore this version" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /^Restore$/ })).toBeNull();
    } finally {
      setMockDoc(DOC.id);
    }
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
