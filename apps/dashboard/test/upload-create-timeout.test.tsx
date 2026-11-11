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
}));

vi.mock("../src/upload/uploadPipeline", async (orig) => ({
  ...(await orig<typeof import("../src/upload/uploadPipeline")>()),
  uploadFiles: m.uploadFiles,
  createArtifact: m.createArtifact,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
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
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Create dialog timeout and retry", () => {
  it("times out a hung create into an error with Retry", async () => {
    m.createArtifact.mockImplementation(hang);
    open();
    await click("Create");
    expect(screen.getByText("Creating…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't create it. The server didn't answer.",
    );
    expect(screen.queryByText("Creating…")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Retry repeats only the create call", async () => {
    m.createArtifact.mockImplementationOnce(hang);
    m.createArtifact.mockResolvedValueOnce({ id: "a1", version: 1 });
    open();
    await click("Create");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    });
    await click("Retry");
    expect(m.uploadFiles).toHaveBeenCalledTimes(1);
    expect(m.createArtifact).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the error with Retry on a 503", async () => {
    m.createArtifact.mockRejectedValue(
      new ApiClientError("internal", "temporarily_unavailable", 503),
    );
    open();
    await click("Create");
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't create it",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("closes and navigates on success, with no error", async () => {
    m.createArtifact.mockResolvedValue({ id: "a1", version: 1 });
    open();
    await click("Create");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(m.uploadFiles).toHaveBeenCalledTimes(1);
    expect(m.createArtifact).toHaveBeenCalledTimes(1);
  });
});
