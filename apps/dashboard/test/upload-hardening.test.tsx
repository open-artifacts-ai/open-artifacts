import { readFileSync } from "node:fs";
import { contentTypeFor, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import {
  UploadValidationError,
  uploadArtifact,
} from "../src/upload/uploadPipeline";
import {
  findVisibleToast,
  installHarness,
  mount,
  seen,
  server,
} from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
  }),
}));

installHarness();

beforeEach(() => {
  vi.spyOn(api, "putRaw").mockImplementation(async (url, _b, type) => {
    await fetch(url, { method: "PUT", headers: { "Content-Type": type } });
  });
});
afterEach(() => {
  server.events.removeAllListeners();
  vi.restoreAllMocks();
});

const uploadBodies = () => {
  const bodies: { path: string; contentType?: string }[] = [];
  server.events.on("request:start", async ({ request }) => {
    const u = new URL(request.url);
    if (request.method === "POST" && u.pathname === "/api/v1/uploads")
      bodies.push(await request.clone().json());
  });
  return bodies;
};

describe("upload hardening", () => {
  it("sends the server's content type (with charset), not the browser's File.type", async () => {
    const bodies = uploadBodies();
    await uploadArtifact(
      {
        files: [
          new File(["<p>é</p>"], "index.html", { type: "text/html" }),
          new File(["let a=1"], "a.ts", { type: "video/mp2t" }),
        ],
        title: "T",
      },
      () => {},
    );
    expect(bodies.map((b) => b.contentType)).toEqual([
      contentTypeFor("index.html"),
      contentTypeFor("a.ts"),
    ]);
  });

  it("rejects an empty file before any request, naming it", async () => {
    await expect(
      uploadArtifact(
        {
          files: [new File(["x"], "index.html"), new File([], "empty.css")],
          title: "T",
        },
        () => {},
      ),
    ).rejects.toThrow(/empty\.css/);
    expect(seen).toHaveLength(0);
  });

  it("rejects a reserved path (__proto__) before any request", async () => {
    await expect(
      uploadArtifact(
        {
          files: [new File(["x"], "index.html"), new File(["x"], "__proto__")],
          title: "T",
        },
        () => {},
      ),
    ).rejects.toThrow(UploadValidationError);
    expect(seen).toHaveLength(0);
  });

  it("aborting cancels a stalled PUT", async () => {
    vi.mocked(api.putRaw).mockImplementation(() => new Promise(() => {}));
    const ac = new AbortController();
    const p = uploadArtifact(
      { files: [new File(["x"], "index.html")], title: "T" },
      () => {},
      ac.signal,
    );
    await waitFor(() => expect(api.putRaw).toHaveBeenCalled());
    ac.abort();
    const r = await Promise.race([
      p.then(
        () => "resolved",
        (e: Error) => e.name,
      ),
      new Promise((res) => setTimeout(() => res("hung"), 200)),
    ]);
    expect(r).toBe("AbortError");
  });

  it("a failed PUT names the file", async () => {
    let n = 0;
    vi.mocked(api.putRaw).mockImplementation(async () => {
      if (++n === 2) throw new Error("Upload failed");
    });
    await expect(
      uploadArtifact(
        {
          files: [new File(["x"], "index.html"), new File(["x"], "a.css")],
          title: "T",
        },
        () => {},
      ),
    ).rejects.toThrow(/a\.css/);
  });

  it("an NFD-named single file uploads from the dialog", async () => {
    const acute = String.fromCharCode(0x301);
    const posts: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST") posts.push(new URL(request.url).pathname);
    });
    mount("/");
    const input = (await screen.findByTestId(
      "upload-files",
    )) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["# hi"], `re${acute}sume${acute}.md`)] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alert")?.textContent ?? posts.join(),
      ).toContain("/api/v1/artifacts"),
    );
  });

  it("a new batch does not reuse the previous entry", async () => {
    mount("/");
    const input = (await screen.findByTestId(
      "upload-files",
    )) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "index.html")] },
    });
    await screen.findByLabelText("Title");
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(["x"], "a.md"), new File(["x"], "b.md")] },
      });
    });
    await screen.findByText("2 files selected");
    // No default entry for [a.md, b.md]: Create must wait for a choice.
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("the drag overlay captures pointer events", () => {
    const css = readFileSync(`${__dirname}/../src/upload/upload.css`, "utf8");
    const block = css.match(/\.up-drop\s*\{[^}]*\}/)?.[0] ?? "";
    expect(block).not.toMatch(/pointer-events:\s*none/);
  });
});

describe("drag over the viewer", () => {
  it("marks the document so the artifact iframe cannot receive the drop", async () => {
    mount("/");
    await screen.findByTestId("upload-files");
    act(() => {
      const e = new Event("dragenter", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"] } });
      window.dispatchEvent(e);
    });
    expect(document.documentElement).toHaveClass("oa-file-drag");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.documentElement).not.toHaveClass("oa-file-drag");
  });

  it("ignores a drop while an upload dialog is open, with a toast", async () => {
    mount("/");
    const input = (await screen.findByTestId(
      "upload-files",
    )) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "index.html")] },
    });
    await screen.findByLabelText("Title");
    const file = new File(["y"], "other.md");
    act(() => {
      const e = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", {
        value: { types: ["Files"], items: [], files: [file] },
      });
      window.dispatchEvent(e);
    });
    await findVisibleToast("Finish the current upload first");
    expect(screen.getByText("1 file selected")).toBeVisible();
  });

  it("shows a toast for a drop with no usable files", async () => {
    mount("/");
    await screen.findByTestId("upload-files");
    act(() => {
      const e = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", {
        value: {
          types: ["Files"],
          items: [],
          files: [new File(["x"], ".DS_Store")],
        },
      });
      window.dispatchEvent(e);
    });
    await findVisibleToast("No files to upload");
  });

  it("clears a stuck overlay after 400 ms without dragover, or on pointer activity", async () => {
    vi.useFakeTimers();
    try {
      mount("/");
      await vi.waitFor(() =>
        expect(screen.getByTestId("upload-files")).toBeTruthy(),
      );
      const enter = () =>
        act(() => {
          const e = new Event("dragenter", { bubbles: true, cancelable: true });
          Object.defineProperty(e, "dataTransfer", {
            value: { types: ["Files"] },
          });
          window.dispatchEvent(e);
        });
      enter();
      expect(document.documentElement).toHaveClass("oa-file-drag");
      act(() => void vi.advanceTimersByTime(401));
      expect(document.documentElement).not.toHaveClass("oa-file-drag");
      expect(screen.queryByText(/Drop files/)).toBeNull();
      enter();
      fireEvent.mouseMove(window);
      expect(screen.queryByText(/Drop files/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("artifact detail", () => {
  const find = (t: string) =>
    (fixtures.artifacts.find((a) => a.title === t) as { id: string }).id;
  it("has no upload-version control for an owner or an editor", async () => {
    for (const title of ["Landing page", "Shared draft"]) {
      mount(viewerPath(find(title)));
      await screen.findByRole("button", { name: /^Version:/ });
      expect(screen.queryByText(/upload version/i)).toBeNull();
      expect(screen.queryByTestId("upload-files")).toBeNull();
      cleanup();
    }
  });
});
