import { diffPath, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { diffRows } from "../src/viewer/Diff";
import { installHarness, intersect, mount, seen, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

const id = (title: string) =>
  (fixtures.artifacts.find((a) => a.title === title) as { id: string }).id;
const OWNED = id("Landing page");
const VIEWER = id("Onboarding guide");
const SCRIPT = id("Parser script");
const panel = (aid: string, v?: number) =>
  `${viewerPath(aid, v)}?panel=open&tab=versions`;

describe("versions panel", () => {
  it("restore confirms, calls the route and navigates to the new version", async () => {
    const router = mount(panel(OWNED, 1));
    await screen.findByText("Update 2");
    const row = screen
      .getByText("Initial version")
      .closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Restore" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restore version" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED, 3)),
    );
    expect(seen.some((u) => u.pathname === R.restoreVersion(OWNED, 1))).toBe(
      true,
    );
  });

  it("editors see Restore, viewers do not", async () => {
    mount(panel(VIEWER));
    await screen.findByText("Initial version");
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("older versions load on scroll, with before", async () => {
    mount(panel(SCRIPT));
    await screen.findByText("Update 25");
    expect(screen.queryByText("Update 5")).toBeNull();
    intersect();
    await screen.findByText("Update 5");
    expect(seen.some((u) => u.searchParams.get("before") === "6")).toBe(true);
  });

  it("tab and panel state live in the URL", async () => {
    const router = mount(`${viewerPath(OWNED)}`);
    await screen.findByRole("button", { name: "Share" });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        panel: "open",
        tab: "share",
      }),
    );
    expect(screen.getByRole("tab", { name: "Versions" })).toBeInTheDocument();
  });
});

describe("diff", () => {
  it("shows the exact added and removed lines for v1 to v2", async () => {
    mount(diffPath(OWNED, 1, 2));
    const del = await screen.findByText("<!doctype html><h1>Landing v1</h1>");
    const add = screen.getByText(
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Landing v2</h1>',
    );
    expect(del.closest("tr")).toHaveAttribute("data-kind", "del");
    expect(add.closest("tr")).toHaveAttribute("data-kind", "add");
    expect(screen.getByText("style.css")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
  });

  it("says Binary file changed for NUL bytes", async () => {
    server.use(
      http.get(
        `*/api/v1/artifacts/${SCRIPT}/versions/:v/files/*`,
        () =>
          new HttpResponse("a\0b", {
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    mount(diffPath(SCRIPT, 1, 2));
    expect(await screen.findByText("Binary file changed")).toBeInTheDocument();
  });

  it("refuses to diff files over 1 MB", async () => {
    server.use(
      http.get(
        `*/api/v1/artifacts/${SCRIPT}/versions/:v/files/*`,
        () =>
          new HttpResponse("x".repeat(1_100_000), {
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    mount(diffPath(SCRIPT, 1, 2));
    expect(
      await screen.findByText("File too large to diff"),
    ).toBeInTheDocument();
  });

  it("invalid versions are not found", async () => {
    mount(diffPath(OWNED, 0, 2));
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });

  it("previews use the exact sandbox", async () => {
    mount(diffPath(OWNED, 1, 2));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Preview" }));
    await waitFor(() =>
      expect(document.querySelectorAll("iframe")).toHaveLength(2),
    );
    for (const f of document.querySelectorAll("iframe"))
      expect(f.getAttribute("sandbox")).toBe(
        "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
      );
  });
});

describe("diff robustness", () => {
  it("gives up within 2 s on two very different files", () => {
    const l = Array.from({ length: 30_000 }, (_, i) => `line${i}`);
    const t = performance.now();
    diffRows(l.join("\n"), [...l].reverse().join("\n"));
    expect(performance.now() - t).toBeLessThan(2000);
  }, 120_000);

  it("renders a 25k-line added file", () => {
    const rows = diffRows("", "x\n".repeat(25_000));
    expect(rows).not.toBeNull();
    expect(rows?.filter((r) => r.kind === "add")).toHaveLength(25_000);
  });

  it("compares the old entry with the new entry when the entry was renamed", async () => {
    const tpl = (fixtures.versions[SCRIPT] ?? [])[0];
    const mk = (v: number, entry: string) => ({
      ...tpl,
      version: v,
      entry,
      files: [{ path: entry, size: 10 + v, contentType: "text/plain" }],
    });
    const fetched: string[] = [];
    server.use(
      http.get(`*/api/v1/artifacts/${SCRIPT}/versions`, ({ request }) => {
        const b = Number(new URL(request.url).searchParams.get("before") ?? 99);
        return HttpResponse.json(
          [mk(2, "new.py"), mk(1, "old.py")].filter((x) => x.version < b),
        );
      }),
      http.get(
        `*/api/v1/artifacts/${SCRIPT}/versions/:v/files/*`,
        ({ params, request }) => {
          fetched.push(new URL(request.url).pathname);
          return new HttpResponse(
            params.v === "1" ? "same\nold\n" : "same\nnew\n",
            { headers: { "content-type": "text/plain" } },
          );
        },
      ),
    );
    mount(diffPath(SCRIPT, 1, 2));
    await screen.findByText("new");
    expect(fetched.includes(R.versionFile(SCRIPT, 1, "old.py"))).toBe(true);
    expect(screen.getByText("same").closest("tr")).toHaveAttribute(
      "data-kind",
      "ctx",
    );
  });

  it("Show all renders rows in bounded chunks", async () => {
    server.use(
      http.get(
        `*/api/v1/artifacts/${SCRIPT}/versions/:v/files/*`,
        ({ params }) =>
          new HttpResponse(`${params.v}\n${"x\n".repeat(20_000)}`, {
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    mount(diffPath(SCRIPT, 1, 2));
    fireEvent.click(await screen.findByRole("button", { name: "Show all" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show changes only" }),
      ).toBeInTheDocument(),
    );
    expect(document.querySelectorAll("tr").length).toBeLessThan(5_000);
    fireEvent.click(screen.getByRole("button", { name: "Show 2000 more" }));
    await waitFor(() =>
      expect(document.querySelectorAll("tr").length).toBeGreaterThan(4_000),
    );
  }, 120_000);

  it("collapses unchanged lines and Show all expands them", async () => {
    server.use(
      http.get(
        `*/api/v1/artifacts/${SCRIPT}/versions/:v/files/*`,
        ({ params }) =>
          new HttpResponse(
            `${"keep\n".repeat(50)}${params.v}\n${"keep\n".repeat(50)}`,
            { headers: { "content-type": "text/plain" } },
          ),
      ),
    );
    mount(diffPath(SCRIPT, 1, 2));
    expect(await screen.findAllByText("47 unchanged lines")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await waitFor(() =>
      expect(screen.queryByText("47 unchanged lines")).toBeNull(),
    );
    expect(document.querySelectorAll("tr[data-kind='ctx']").length).toBe(100);
  });

  it("falls back to downloads when the diff is too expensive", async () => {
    const l = Array.from({ length: 30_000 }, (_, i) => `line${i}`);
    server.use(
      http.get(
        `*/api/v1/artifacts/${SCRIPT}/versions/:v/files/*`,
        ({ params }) =>
          new HttpResponse(
            (params.v === "1" ? l : [...l].reverse()).join("\n"),
            { headers: { "content-type": "text/plain" } },
          ),
      ),
    );
    mount(diffPath(SCRIPT, 1, 2));
    expect(
      await screen.findByText(
        /Too many differences to display/,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "v1" })).toHaveAttribute(
      "href",
      R.versionFile(SCRIPT, 1, "parse.ts"),
    );
  }, 20_000);
});

describe("versions and diff details", () => {
  it("links Compare with current", async () => {
    mount(panel(OWNED, 1));
    await screen.findByText("Initial version");
    expect(
      screen.getByRole("link", { name: "Compare with current" }),
    ).toHaveAttribute("href", diffPath(OWNED, 1, 2));
  });

  it("labels added files and a file with no counterpart", async () => {
    mount(diffPath(OWNED, 1, 2));
    expect(await screen.findByText("Added")).toBeInTheDocument();
    expect(screen.getByText("Changed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "style.css" }));
    expect(await screen.findByText("h1 { color: teal; }")).toBeInTheDocument();
    expect(
      screen.getByText("h1 { color: teal; }").closest("tr"),
    ).toHaveAttribute("data-kind", "add");
  });

  it("labels removed files and shows them as deletions", async () => {
    mount(diffPath(OWNED, 2, 1));
    expect(await screen.findByText("Removed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "style.css" }));
    expect(
      (await screen.findByText("h1 { color: teal; }")).closest("tr"),
    ).toHaveAttribute("data-kind", "del");
  });

  it("keeps panel and tab after restore", async () => {
    const router = mount(panel(OWNED, 1));
    await screen.findByText("Initial version");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restore version" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED, 3)),
    );
    expect(router.state.location.search).toMatchObject({
      panel: "open",
      tab: "versions",
    });
  });

  it("diffRows handles one-sided input", () => {
    expect(diffRows("a\nb\n", "")?.map((r) => r.kind)).toEqual(["del", "del"]);
  });
});

describe("panel focus", () => {
  it("moves focus to the active tab and back to the toggle on close", async () => {
    mount(viewerPath(OWNED));
    const toggle = await screen.findByRole("button", { name: "Share" });
    toggle.focus();
    fireEvent.click(toggle);
    const aside = await screen.findByRole("complementary", {
      name: "Side panel",
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Share" })).toHaveFocus(),
    );
    expect(aside).not.toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(toggle).toHaveFocus());
  });
});
