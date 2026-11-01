import { JOB_STEPS, type Job } from "@oa/shared/provisioning";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  JOB_FAST_WINDOW_MS,
  JOB_POLL_MS,
  JOB_POLL_SLOW_MS,
  jobIsTerminal,
  jobQuery,
} from "../src/api/queries";
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
  expect(steps()).toEqual(["done", "done", "done", "done", "current"]);
  // Attempt 1 is not shown; the code and the retry are.
  expect(screen.queryByTestId("attempt")).toBeNull();
  expect(screen.getByTestId("attempt-line")).toHaveTextContent(/^cf_error · /);
  expect(screen.getByTestId("retry-at")).toHaveTextContent(/^retrying /);
  expect(screen.getByTestId("job-error")).toHaveTextContent(
    /Cloudflare returned an error/,
  );
});

it("shows Design's step labels, step count and the attempt line", async () => {
  // 75 s out reads "1 min" for anything from 30 s to 90 s, so render time can't move it.
  const retryAt = Date.now() + 75_000;
  serve({
    ...jobsByStatus.running,
    kind: "create",
    steps: [...JOB_STEPS.create],
    stepIndex: 5,
    step: "verify_clean",
    attempt: 2,
    lastErrorCode: "cf_error",
    retryAt,
  });
  renderApp(`/jobs/${JOB}`);
  expect(
    await screen.findByRole("heading", { name: /^Creating/ }),
  ).toBeInTheDocument();
  const list = within(screen.getByRole("list", { name: "Steps" }));
  expect(
    list.getAllByRole("listitem").map((li) => li.firstChild?.textContent),
  ).toEqual([
    "Queue the job",
    "Check the request",
    "Reserve slug and hosts",
    "Check the release",
    "Upload",
    "Verify clean",
    "Health check",
    "Route hosts",
    "Turn on sign-in",
    "Check it answers",
    "Notify",
  ]);
  expect(screen.getByText(/· step 6 of 11/)).toBeInTheDocument();
  expect(screen.getByTestId("attempt-line")).toHaveTextContent(
    "Attempt 2 · cf_error · retrying in 1 min",
  );
});

it("shows the attempt only from the second one, and never Attempt 0", async () => {
  serve({
    ...jobsByStatus.running,
    attempt: 1,
    lastErrorCode: "cf_error",
    retryAt: Date.now() + 30_000,
  });
  const a = renderApp(`/jobs/${JOB}`);
  expect(await screen.findByTestId("attempt-line")).toHaveTextContent(
    /^cf_error · retrying in \d+ s$/,
  );
  expect(screen.queryByTestId("attempt")).toBeNull();
  a.unmount();

  serve({
    ...jobsByStatus.running,
    attempt: 0,
    lastErrorCode: null,
    error: null,
    retryAt: null,
  });
  renderApp(`/jobs/${JOB}`);
  await screen.findByRole("list", { name: "Steps" });
  expect(screen.queryByText(/Attempt/)).toBeNull();
  expect(screen.queryByTestId("attempt-line")).toBeNull();
});

it("breadcrumb ends at the install, with no trailing slash", async () => {
  serve(jobsByStatus.running);
  renderApp(`/jobs/${JOB}`);
  await screen.findByRole("list", { name: "Steps" });
  const crumbs = document.querySelector<HTMLElement>(".oa-crumbs");
  if (!crumbs) throw new Error("no breadcrumb");
  await waitFor(() =>
    expect(within(crumbs).getAllByRole("link").at(-1)).toHaveAttribute(
      "href",
      `/installs/${jobsByStatus.running.installId}`,
    ),
  );
  expect(crumbs.textContent?.trim()).not.toMatch(/\/$/);
});

it("a failed job: named by its kind with a Failed chip, no If you cancel or If it fails; the step shows its code", async () => {
  serve(jobsByStatus.running);
  const a = renderApp(`/jobs/${JOB}`);
  expect(
    await screen.findByRole("heading", { name: "If you cancel" }),
  ).toBeInTheDocument();
  a.unmount();

  serve({
    ...jobsByStatus.failed,
    kind: "create",
    installId: FIXTURE_IDS.broken,
    steps: [...JOB_STEPS.create],
    stepIndex: 5,
    attempt: 1,
    lastErrorCode: "prod_dirty",
    error: { code: "prod_dirty", message: "verify_clean refused" },
  });
  renderApp(`/jobs/${JOB}`);
  await screen.findByTestId("job-error");
  expect(screen.queryByRole("heading", { name: "If you cancel" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "If it fails" })).toBeNull();
  const title = await screen.findByRole("heading", {
    level: 1,
    name: "Create broken",
  });
  expect(title.parentElement).toHaveTextContent(/Failed$/);
  const failed = within(screen.getByRole("list", { name: "Steps" }))
    .getAllByRole("listitem")
    .find((li) => li.getAttribute("data-step") === "failed");
  expect(failed).toHaveTextContent("Verify clean");
  expect(failed?.querySelector("small")).toHaveTextContent(/^prod_dirty$/);
  // Codes render in mono.
  expect(failed?.querySelector("small code")).toHaveTextContent("prod_dirty");
  expect(
    within(screen.getByTestId("job-error")).getByText("verify_clean refused")
      .tagName,
  ).toBe("CODE");
});

it("a failed create names the step and says nothing was routed; Retry is offered on a failed install", async () => {
  serve({
    ...jobsByStatus.failed,
    kind: "create",
    installId: FIXTURE_IDS.broken,
    steps: [...JOB_STEPS.create],
    stepIndex: 3,
    lastErrorCode: "release_unverified",
    error: { code: "release_unverified", message: "no signature" },
  });
  renderApp(`/jobs/${JOB}`);
  const err = await screen.findByTestId("job-error");
  expect(err).toHaveTextContent(
    'Create stopped at "Check the release": release_unverified. Nothing was routed.',
  );
  fireEvent.click(await within(err).findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].path).toBe(`/api/v1/installs/${FIXTURE_IDS.broken}/retry`);
});

it("shows the attempt line on a queued job waiting for a retry", async () => {
  serve({
    ...jobsByStatus.queued,
    attempt: 2,
    lastErrorCode: "cf_error",
    retryAt: Date.now() + 90_000,
  });
  renderApp(`/jobs/${JOB}`);
  expect(await screen.findByTestId("attempt-line")).toHaveTextContent(
    /^Attempt 2 · cf_error · retrying in [12] min$/,
  );
});

it("Retry on a failed create opens the new job", async () => {
  serve({
    ...jobsByStatus.failed,
    kind: "create",
    installId: FIXTURE_IDS.broken,
    steps: [...JOB_STEPS.create],
    stepIndex: 3,
    lastErrorCode: "release_unverified",
    error: { code: "release_unverified", message: "x" },
  });
  const { router } = renderApp(`/jobs/${JOB}`);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(router.state.location.pathname).not.toBe(`/jobs/${JOB}`),
  );
  expect(router.state.location.pathname).toMatch(/^\/jobs\/[0-9A-Z]{26}$/);
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

it("polls every 2 s for the first 2 min of a job, then every 10 s, and not once it is over", () => {
  expect(JOB_POLL_MS).toBe(2000);
  expect(JOB_POLL_SLOW_MS).toBe(10_000);
  expect(JOB_FAST_WINDOW_MS).toBe(120_000);
  const interval = jobQuery(JOB).refetchInterval as (q: {
    state: { data?: Job };
  }) => number | false;
  const aged = (s: "queued" | "running", ms: number) => ({
    state: { data: { ...jobsByStatus[s], createdAt: Date.now() - ms } },
  });
  for (const s of ["queued", "running"] as const) {
    expect(interval(aged(s, 0))).toBe(2000);
    expect(interval(aged(s, 119_000))).toBe(2000);
    expect(interval(aged(s, 120_000))).toBe(10_000);
    expect(interval(aged(s, 3_600_000))).toBe(10_000);
  }
  for (const s of ["done", "failed"] as const) {
    expect(jobIsTerminal(s)).toBe(true);
    expect(interval({ state: { data: jobsByStatus[s] } })).toBe(false);
  }
});

it("slows to 10 s once the job is 2 min old, and stops at done", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let status: "running" | "done" = "running";
    const createdAt = Date.now() - 118_000;
    use(
      http.get(`*/api/v1/jobs/${JOB}`, () =>
        json({ ...jobsByStatus[status], createdAt }),
      ),
    );
    renderApp(`/jobs/${JOB}`);
    await screen.findByTestId("status");
    const calls = () =>
      seen.filter((s) => s.path.endsWith(`/jobs/${JOB}`)).length;
    expect(calls()).toBe(1);
    // Still inside the 2 min window: the next poll comes after 2 s.
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    await waitFor(() => expect(calls()).toBe(2));
    // Now past it: nothing for the next 8 s, then one poll at 10 s.
    await vi.advanceTimersByTimeAsync(JOB_POLL_SLOW_MS - 2000);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(calls()).toBe(3));
    status = "done";
    await vi.advanceTimersByTimeAsync(JOB_POLL_SLOW_MS);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("done"),
    );
    const settled = calls();
    await vi.advanceTimersByTimeAsync(JOB_POLL_SLOW_MS * 3);
    expect(calls()).toBe(settled);
  } finally {
    vi.useRealTimers();
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

// The mock's jobs are dated long ago, so they poll at the slow rate.
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
    await vi.advanceTimersByTimeAsync(JOB_POLL_SLOW_MS);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    expect(calls()).toBe(2);
    mock.advanceJob(id, "done");
    await vi.advanceTimersByTimeAsync(JOB_POLL_SLOW_MS);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("done"),
    );
    const settled = calls();
    await vi.advanceTimersByTimeAsync(JOB_POLL_SLOW_MS * 5);
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
    await vi.advanceTimersByTimeAsync(JOB_POLL_SLOW_MS);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("failed"),
    );
    expect(screen.getByTestId("job-error")).toHaveTextContent(/leftovers/);
    const calls = () =>
      seen.filter((s) => s.path.endsWith(`/jobs/${id}`)).length;
    const settled = calls();
    await vi.advanceTimersByTimeAsync(JOB_POLL_SLOW_MS * 5);
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
