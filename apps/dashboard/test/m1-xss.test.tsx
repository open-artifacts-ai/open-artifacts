// M1 whole-track review: hostile strings rendered on every surface stay inert text.
import { R, type VersionInfo } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { arts, installHarness, mount, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

const X = `<img src=x onerror="window.__xss=1">"><svg onload=alert(1)>`;
const base = arts.find((a) => a.title === "Landing page");
if (!base) throw new Error("fixture");
const ID = base.id;
const hostile = {
  ...base,
  title: `T${X}`,
  description: `D${X}`,
  owner: { ...base.owner, id: "Zz9zZz9zZz9zZz9z", name: `O${X}` },
  lastAgent: { name: `A${X}`, version: "1" },
};
const versions = (
  (fixtures as unknown as { versions: Record<string, VersionInfo[]> }).versions[
    ID
  ] ?? []
).map((v) => ({
  ...v,
  message: `M${X}`,
  agent: { name: `A${X}`, version: "1" },
  createdBy: { ...v.createdBy, name: `C${X}` },
  entry: `e${X}.html`,
  files: v.files.map((f, i) => ({
    ...f,
    path: i === 0 ? `e${X}.html` : `f${X}.css`,
  })),
}));

const install = () =>
  server.use(
    http.get("*/api/v1/artifacts", () =>
      HttpResponse.json({ items: [hostile], nextCursor: null }),
    ),
    http.get("*/api/v1/artifacts/:id", () => HttpResponse.json(hostile)),
    http.get("*/api/v1/artifacts/:id/versions", ({ request }) => {
      const before = new URL(request.url).searchParams.get("before");
      return HttpResponse.json(
        versions.filter((v) => !before || v.version < Number(before)),
      );
    }),
    http.get("*/api/v1/artifacts/:id/versions/:v/files/*", ({ params }) =>
      HttpResponse.text(`body ${X} v${params.v}`, {
        headers: { "content-type": "text/html" },
      }),
    ),
    http.get("*/api/v1/search", () =>
      HttpResponse.json({
        items: [{ ...hostile, snippet: `S\u0002${X}\u0003${X}` }],
        nextCursor: null,
      }),
    ),
  );

const inert = () => {
  expect((window as { __xss?: number }).__xss).toBeUndefined();
  expect(
    document.querySelector('img[src="x"], svg[onload], script'),
  ).toBeNull();
};

describe("M1 XSS: hostile titles, names, messages, paths, snippets", () => {
  it("library grid and list", async () => {
    install();
    mount("/");
    await screen.findByRole("link", { name: `T${X}` });
    expect(screen.getAllByText(`A${X}`).length).toBeGreaterThan(0);
    inert();
    mount("/?view=list");
    await screen.findAllByRole("link", { name: `T${X}` });
    inert();
  });

  it("search rows with marked snippet", async () => {
    install();
    mount("/search?q=x");
    await screen.findByRole("link", { name: `T${X}` });
    expect(document.querySelector("mark")?.textContent).toBe(X);
    inert();
  });

  it("viewer title bar, crumbs, iframe title, timeline", async () => {
    install();
    mount(`${R.artifact(ID).replace("/api/v1/artifacts", "/a")}?panel=open`);
    await screen.findAllByText(`M${X}`);
    expect(screen.getByRole("button", { name: `T${X}` })).toBeInTheDocument();
    expect(document.querySelector("iframe")?.getAttribute("title")).toBe(
      `T${X}`,
    );
    inert();
  });

  it("diff file list and source rows", async () => {
    install();
    mount(`/a/${ID}/diff/1/2`);
    await screen.findByRole("button", { name: `e${X}.html` });
    await waitFor(() =>
      expect(screen.getAllByText(`body ${X} v2`).length).toBeGreaterThan(0),
    );
    inert();
  });
});
