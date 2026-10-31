import type { Job } from "@oa/shared/provisioning";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { JOB_POLL_MS, jobIsTerminal, jobQuery } from "../src/api/queries";
import { FIXTURE_IDS, jobsByStatus } from "../src/mocks/fixtures";
import { http, json, mock, renderApp, seen, use, writes } from "./harness";

const JOB = FIXTURE_IDS.jobLeo;
const serve = (j: Job) => use(http.get(`*/api/v1/jobs/${j.id}`, () => json(j)));
const steps = () =>
  within(screen.getByRole("list", { name: "Steps" }))
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("data-step"));

it("shows steps, attempt, the last error in plain words and the next retry", async () => {
  serve(jobsByStatus.running);
  renderApp(`/jobs/${JOB}`);
  expect(await screen.findByTestId("status")).toHaveTextContent("running");
  expect(steps()).toEqual([
    "done",
    "done",
    "done",
    "done",
    "current",
    "waiting",
  ]);
  expect(screen.getByTestId("attempt")).toHaveTextContent("1");
  expect(screen.getByTestId("retry-at")).toBeInTheDocument();
  expect(screen.getByTestId("job-error")).toHaveTextContent(
    /Cloudflare returned an error/,
  );
});

it("shows a queued job, a done job and a failed job", async () => {
  serve(jobsByStatus.queued);
  const a = renderApp(`/jobs/${JOB}`);
  expect(await screen.findByTestId("status")).toHaveTextContent("queued");
  expect(steps().every((s) => s === "waiting")).toBe(true);
  a.unmount();

  serve(jobsByStatus.done);
  const b = renderApp(`/jobs/${JOB}`);
  await waitFor(() =>
    expect(screen.getByTestId("status")).toHaveTextContent("done"),
  );
  expect(steps().every((s) => s === "done")).toBe(true);
  expect(screen.queryByRole("button", { name: "Cancel job" })).toBeNull();
  b.unmount();

  serve(jobsByStatus.failed);
  renderApp(`/jobs/${JOB}`);
  await waitFor(() =>
    expect(screen.getByTestId("status")).toHaveTextContent("failed"),
  );
  expect(steps()[jobsByStatus.failed.stepIndex]).toBe("failed");
  expect(screen.getByTestId("job-error")).toHaveTextContent(
    /older than the one installed/,
  );
  expect(screen.getByTestId("job-error")).toHaveTextContent(
    "1.40.0 is older than 1.42.0",
  );
  expect(screen.queryByTestId("retry-at")).toBeNull();
});

it("polls every 2 s while the job is active and not once it is done or failed", () => {
  expect(JOB_POLL_MS).toBe(2000);
  const interval = jobQuery(JOB).refetchInterval as (q: {
    state: { data?: Job };
  }) => number | false;
  for (const s of ["queued", "running"] as const)
    expect(interval({ state: { data: jobsByStatus[s] } })).toBe(2000);
  for (const s of ["done", "failed"] as const) {
    expect(jobIsTerminal(s)).toBe(true);
    expect(interval({ state: { data: jobsByStatus[s] } })).toBe(false);
  }
});

/** Start a create job on the mock, as the create screen would. */
async function startJob(slug = "polled") {
  const res = await fetch("/api/v1/installs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: `req-${slug}-0123456789`,
      slug,
      ownerEmail: "o@example.com",
      tier: "team",
      auth: { providers: ["google"], domains: ["example.com"] },
    }),
  });
  return ((await res.json()) as { job: Job }).job.id;
}

it("keeps polling an active job, then stops once it is done", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const id = await startJob();
    seen.length = 0;
    renderApp(`/jobs/${id}`);
    expect(await screen.findByTestId("status")).toHaveTextContent("queued");
    const calls = () =>
      seen.filter((s) => s.path.endsWith(`/jobs/${id}`)).length;
    expect(calls()).toBe(1);
    mock.advanceJob(id, "running");
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    expect(calls()).toBe(2);
    mock.advanceJob(id, "done");
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("done"),
    );
    const settled = calls();
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 5);
    expect(calls()).toBe(settled);
  } finally {
    vi.useRealTimers();
  }
});

it("stops polling at a failed job and shows its error", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const id = await startJob("doomed");
    renderApp(`/jobs/${id}`);
    await screen.findByTestId("status");
    mock.advanceJob(id, "failed", "prod_dirty");
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("failed"),
    );
    expect(screen.getByTestId("job-error")).toHaveTextContent(/leftovers/);
    const calls = () =>
      seen.filter((s) => s.path.endsWith(`/jobs/${id}`)).length;
    const settled = calls();
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 5);
    expect(calls()).toBe(settled);
  } finally {
    vi.useRealTimers();
  }
});

it("stops polling when the job cannot be loaded", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    use(
      http.get(`*/api/v1/jobs/${JOB}`, () =>
        json({ error: { code: "not_found", message: "x" } }, 404),
      ),
    );
    renderApp(`/jobs/${JOB}`);
    await screen.findByText("Job not found");
    const calls = () =>
      seen.filter((s) => s.path.endsWith(`/jobs/${JOB}`)).length;
    const once = calls();
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 5);
    expect(calls()).toBe(once);
    const interval = jobQuery(JOB).refetchInterval as (q: {
      state: { data?: Job; status: string };
    }) => number | false;
    expect(interval({ state: { status: "error" } })).toBe(false);
    expect(interval({ state: { status: "pending" } })).toBe(2000);
  } finally {
    vi.useRealTimers();
  }
});

it("cancels with the install slug typed, and the job settles failed", async () => {
  const id = await startJob("cancelme");
  renderApp(`/jobs/${id}`);
  const open = await screen.findByRole("button", { name: "Cancel job" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  const dialog = await screen.findByRole("dialog");
  const go = within(dialog).getByRole("button", { name: "Cancel job" });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "cancelme" },
  });
  fireEvent.click(go);
  await waitFor(() =>
    expect(writes().at(-1)?.path).toBe(`/api/v1/jobs/${id}/cancel`),
  );
  expect(writes().at(-1)?.body).toMatchObject({ confirmSlug: "cancelme" });
  await waitFor(() =>
    expect(screen.getByTestId("status")).toHaveTextContent("failed"),
  );
  expect(screen.getByTestId("job-error")).toHaveTextContent(
    "The job was canceled.",
  );
});

it("says a missing job is not found", async () => {
  renderApp("/jobs/01JD7Z9W5Q8X3N4M2K1H0G9F00");
  expect(await screen.findByText("Job not found")).toBeInTheDocument();
});
