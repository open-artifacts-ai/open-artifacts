import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, mount, server } from "./harness";

const dispose = vi.fn();
const createBridge = vi.fn(() => ({
  dispose,
  requestThumbnail: vi.fn(),
  setTheme: vi.fn(),
  setArtifact: vi.fn(),
}));
vi.mock("../src/viewer/bridge", () => ({
  createBridge: (...a: unknown[]) =>
    (createBridge as (...x: unknown[]) => unknown)(...a),
}));

installHarness();
beforeEach(() => {
  createBridge.mockClear();
  dispose.mockClear();
});

const id = (title: string) =>
  (fixtures.artifacts.find((a) => a.title === title) as { id: string }).id;
const OWNED = id("Landing page"); // access owner, 2 versions
const VIEWER = id("Onboarding guide"); // access viewer
const EDITOR = id("Shared draft"); // access editor
const PUBLIC = id("Q4 report");

const frame = () =>
  waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f) throw new Error("no iframe");
    return f;
  });
const anonymous = () =>
  server.use(
    http.get("*/api/v1/me", () =>
      HttpResponse.json(
        { error: { code: "unauthorized", message: "no" } },
        { status: 401 },
      ),
    ),
  );

describe("viewer shell", () => {
  it("renders the iframe with exact sandbox attributes", async () => {
    mount(viewerPath(OWNED));
    const f = await frame();
    const sb = f.getAttribute("sandbox");
    expect(sb).toBe(
      "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
    );
    expect(sb).not.toContain("allow-same-origin");
    expect(sb).not.toContain("allow-top-navigation");
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.getAttribute("allow")).toBe("clipboard-write");
    expect(f.getAttribute("title")).toBe("Landing page");
  });

  it("owner sees Share and Delete", async () => {
    mount(viewerPath(OWNED));
    await frame();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    expect(
      await screen.findByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
  });

  it("viewer sees neither and cannot edit the title", async () => {
    mount(viewerPath(VIEWER));
    await frame();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByTitle("Rename")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    await screen.findByRole("menuitem", { name: "Copy link" });
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("anonymous visitor of a public artifact gets minimal chrome and Sign in", async () => {
    anonymous();
    mount(viewerPath(PUBLIC));
    await frame();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    // Full screen (#290) stays for anonymous visitors, on phones too.
    expect(screen.getByRole("link", { name: "Full screen" })).toHaveAttribute(
      "href",
      `${viewerPath(PUBLIC)}/full`,
    );
  });

  it("anonymous visitor: owner and authors with no name and no email render fine", async () => {
    anonymous();
    const nobody = { id: "u_x", name: null, email: null };
    const art = fixtures.artifacts.find((a) => a.id === PUBLIC);
    const vers = (fixtures.versions[PUBLIC] ?? []).map((v) => ({
      ...v,
      createdBy: nobody,
    }));
    server.use(
      http.get(`*/api/v1/artifacts/${PUBLIC}`, () =>
        HttpResponse.json({ ...art, owner: nobody }),
      ),
      http.get(`*/api/v1/artifacts/${PUBLIC}/versions`, () =>
        HttpResponse.json(vers),
      ),
    );
    mount(viewerPath(PUBLIC));
    await frame();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/@/);
  });

  it("changing version remounts the iframe and disposes the old bridge", async () => {
    const router = mount(viewerPath(OWNED));
    const first = await frame();
    await waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1));
    await act(() => router.navigate({ to: viewerPath(OWNED, 1) as string }));
    await waitFor(() => expect(createBridge).toHaveBeenCalledTimes(2));
    expect(dispose).toHaveBeenCalledTimes(1);
    const second = await frame();
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });

  it("version picker navigates to /a/$id/v/$v", async () => {
    const router = mount(viewerPath(OWNED));
    await frame();
    fireEvent.click(screen.getByRole("button", { name: /^Version:/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^v1, / }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED, 1)),
    );
  });

  it("renders NotFound for a 404", async () => {
    mount("/a/Zz9zZz9zZz9zZz9z");
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });

  describe("title edit", () => {
    const edit = async () => {
      mount(viewerPath(EDITOR));
      await frame();
      fireEvent.click(screen.getByTitle("Rename"));
      return screen.getByLabelText("Title") as HTMLInputElement;
    };

    it("trims and saves via PATCH on Enter", async () => {
      let body: unknown;
      server.use(
        http.patch("*/api/v1/artifacts/:id", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            ...fixtures.artifacts.find((a) => a.id === EDITOR),
            title: "New name",
          });
        }),
      );
      const input = await edit();
      fireEvent.change(input, { target: { value: "  New name  " } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(body).toEqual({ title: "New name" }));
    });

    it("rejects empty titles", async () => {
      let patched = false;
      server.use(
        http.patch("*/api/v1/artifacts/:id", () => {
          patched = true;
          return HttpResponse.json({});
        }),
      );
      const input = await edit();
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.blur(input);
      await screen.findByTitle("Rename");
      expect(patched).toBe(false);
    });

    it("Esc cancels without saving", async () => {
      let patched = false;
      server.use(
        http.patch("*/api/v1/artifacts/:id", () => {
          patched = true;
          return HttpResponse.json({});
        }),
      );
      const input = await edit();
      fireEvent.change(input, { target: { value: "Nope" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await screen.findByTitle("Rename");
      expect(screen.getByTitle("Rename")).toHaveTextContent("Shared draft");
      expect(patched).toBe(false);
    });
  });

  it("refetches the artifact when the bridge reports lost access (4403)", async () => {
    let gets = 0;
    server.use(
      http.get("*/api/v1/artifacts/:id", () => {
        gets++;
        return HttpResponse.json(
          fixtures.artifacts.find((a) => a.id === OWNED),
        );
      }),
    );
    mount(viewerPath(OWNED));
    await frame();
    await waitFor(() => expect(createBridge).toHaveBeenCalled());
    const before = gets;
    const opts = createBridge.mock.calls[0] as unknown as [
      { onAccessLost: () => void },
    ];
    act(() => opts[0].onAccessLost());
    await waitFor(() => expect(gets).toBeGreaterThan(before));
  });
});
