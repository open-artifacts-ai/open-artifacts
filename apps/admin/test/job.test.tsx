import type { Job } from "@oa/shared/provisioning";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { JOB_POLL_MS, jobIsTerminal, jobQuery } from "../src/api/queries";
import { FIXTURE_IDS, jobsByStatus } from "../src/mocks/fixtures";
import { http, json, renderApp, seen, use, writes } from "./harness";

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

it("keeps polling a running job, then stops once it is done", async () => {
  let n = 0;
  use(
    http.get(`*/api/v1/jobs/${JOB}`, () =>
      json(++n < 3 ? jobsByStatus.running : jobsByStatus.done),
    ),
  );
  renderApp(`/jobs/${JOB}`);
  await screen.findByTestId("status");
  await waitFor(
    () => expect(screen.getByTestId("status")).toHaveTextContent("done"),
    {
      timeout: 9000,
    },
  );
  const calls = () =>
    seen.filter((s) => s.path.endsWith(`/jobs/${JOB}`)).length;
  const settled = calls();
  expect(settled).toBe(3);
  await new Promise((r) => setTimeout(r, JOB_POLL_MS + 500));
  expect(calls()).toBe(settled);
});

it("cancels with the install slug typed", async () => {
  serve(jobsByStatus.running);
  renderApp(`/jobs/${JOB}`);
  const open = await screen.findByRole("button", { name: "Cancel job" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  const dialog = await screen.findByRole("dialog");
  const go = within(dialog).getByRole("button", { name: "Cancel job" });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "leo" },
  });
  fireEvent.click(go);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].path).toBe(`/api/v1/jobs/${JOB}/cancel`);
  expect(writes()[0].body).toMatchObject({ confirmSlug: "leo" });
});

it("says a missing job is not found", async () => {
  renderApp("/jobs/01JD7Z9W5Q8X3N4M2K1H0G9F00");
  expect(await screen.findByText("Job not found")).toBeInTheDocument();
});
