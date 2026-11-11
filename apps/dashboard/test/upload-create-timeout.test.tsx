import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../src/api/client";

const m = vi.hoisted(() => ({
  uploadFiles: vi.fn(),
  createArtifact: vi.fn(),
  get: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../src/api/client")>()),
  api: { get: m.get },
}));
vi.mock("../src/upload/uploadPipeline", async (orig) => ({
  ...(await orig<typeof import("../src/upload/uploadPipeline")>()),
  uploadFiles: m.uploadFiles,
  createArtifact: m.createArtifact,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => m.navigate }));
vi.mock("../src/auth/permissions", () => ({
  useHosted: () => ({ features: [], personalSpaceId: undefined }),
}));

import { CREATE_TIMEOUT_MS, UploadDialog } from "../src/upload/UploadDialog";

const uploaded = { reserved: "a1", files: { "a.md": { uploadId: "u1" } } };
const hang = (_i: unknown, _u: unknown, signal: AbortSignal) =>
  new Promise((_, reject) =>
    signal.addEventListener("abort", () =>
      reject(new DOMException("Aborted", "AbortError")),
    ),
  );

const open = () => {
  const file = new File(["# hi"], "a.md", { type: "text/markdown" });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <UploadDialog files={[file]} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
};
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  m.uploadFiles.mockReset().mockResolvedValue(uploaded);
  m.createArtifact.mockReset();
  m.get.mockReset();
  m.navigate.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Create dialog timeout and retry", () => {
  it("times out a hung create into an error with Try again", async () => {
    m.createArtifact.mockImplementation(hang);
    open();
    await click("Create");
    expect(screen.getByText("Creating…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't create the artifact: the server didn't answer. Your file is still here.",
    );
    expect(screen.queryByText("Creating…")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("Try again repeats only the create call", async () => {
    m.createArtifact.mockImplementationOnce(hang);
    m.createArtifact.mockResolvedValueOnce({ id: "a1", version: 1 });
    open();
    await click("Create");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    });
    await click("Try again");
    expect(m.uploadFiles).toHaveBeenCalledTimes(1);
    expect(m.createArtifact).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the error with Try again on a 503", async () => {
    m.createArtifact.mockRejectedValue(
      new ApiClientError("internal", "temporarily_unavailable", 503),
    );
    open();
    await click("Create");
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't create the artifact",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("closes and navigates on success, with no error", async () => {
    m.createArtifact.mockResolvedValue({ id: "a1", version: 1 });
    open();
    await click("Create");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(m.uploadFiles).toHaveBeenCalledTimes(1);
    expect(m.createArtifact).toHaveBeenCalledTimes(1);
  });

  it("navigates to a create that landed, when Try again is refused as invalid_upload", async () => {
    m.createArtifact.mockImplementationOnce(hang);
    m.createArtifact.mockRejectedValueOnce(
      new ApiClientError("bad_request", "used", 400, {
        reason: "invalid_upload",
      }),
    );
    m.get.mockRejectedValueOnce(new Error("not yet"));
    open();
    await click("Create");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    });
    m.get.mockReset().mockResolvedValue({ id: "a1", currentVersion: 1 });
    await click("Try again");
    expect(m.navigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(m.uploadFiles).toHaveBeenCalledTimes(1);
  });

  it("a changed entry file reaches the create call", async () => {
    m.createArtifact.mockImplementationOnce(hang);
    m.createArtifact.mockResolvedValueOnce({ id: "a1", version: 1 });
    m.get.mockRejectedValue(new Error("404"));
    const files = [
      new File(["a"], "a.md", { type: "text/markdown" }),
      new File(["b"], "b.md", { type: "text/markdown" }),
    ];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <UploadDialog files={files} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    m.uploadFiles.mockResolvedValue({ ...uploaded, entry: "a.md" });
    // No default entry for two files: choose one first.
    fireEvent.click(screen.getByRole("combobox", { name: "Entry file" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "a.md" }));
    });
    await click("Create");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Entry file" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "b.md" }));
    });
    await click("Try again");
    expect(m.createArtifact.mock.calls[1]?.[1].entry).toBe("b.md");
  });
});
