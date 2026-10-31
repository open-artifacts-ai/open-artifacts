import type { InstallDetail, InstallState } from "@oa/shared/provisioning";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURE_IDS, installsByState } from "../src/mocks/fixtures";
import { apiErr, http, json, renderApp, use, writes } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const serve = (i: InstallDetail) =>
  use(http.get(`*/api/v1/installs/${i.id}`, () => json(i)));
const open = async (i: InstallDetail) => {
  serve(i);
  const view = renderApp(`/installs/${i.id}`);
  await screen.findByRole("heading", { name: i.slug });
  return view;
};
const buttons = () =>
  within(screen.getByRole("region", { name: "Actions" }))
    .queryAllByRole("button")
    .map((b) => b.textContent);

const EXPECTED: Record<InstallState, string[]> = {
  provisioning: ["Cancel job"],
  active: ["Upgrade", "Roll back", "Suspend", "Delete"],
  suspended: ["Upgrade", "Roll back", "Resume", "Delete"],
  deleting: ["Restore", "Purge"],
  deleted: [],
  failed: ["Retry", "Purge"],
};

for (const [state, want] of Object.entries(EXPECTED) as [
  InstallState,
  string[],
][]) {
  it(`shows only the actions valid for a ${state} install`, async () => {
    await open(installsByState[state]);
    expect(buttons()).toEqual(want);
  });
}

it("shows the fields, the suspend reason and the grace window", async () => {
  await open(installsByState.suspended);
  expect(screen.getByText(/Reason: Unpaid invoice/)).toBeInTheDocument();
  expect(screen.getByText("owner@example.com")).toBeInTheDocument();
});

it("shows a mismatch banner and a lease with a release action", async () => {
  await open({
    ...installsByState.active,
    mismatch: "mode_paused",
    lease: { held: true, until: Date.now() - 1000 },
  });
  expect(screen.getByTestId("mismatch")).toHaveTextContent("mode_paused");
  expect(screen.getByTestId("lease")).toBeInTheDocument();
  expect(buttons()).toContain("Release lease");
});

it("links the active job and disables the lifecycle actions", async () => {
  await open({ ...installsByState.active, activeJobId: FIXTURE_IDS.jobLeo });
  expect(screen.getByRole("link", { name: "View the job" })).toHaveAttribute(
    "href",
    `/jobs/${FIXTURE_IDS.jobLeo}`,
  );
  expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel job" })).toBeEnabled();
});

it("delete is type-to-confirm on the slug", async () => {
  const i = installsByState.active;
  const { router } = await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog");
  const go = within(dialog).getByRole("button", { name: "Delete" });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "wrong" },
  });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: i.slug },
  });
  expect(go).toBeEnabled();
  fireEvent.click(go);
  await waitFor(() =>
    expect(router.state.location.pathname).toMatch(/^\/jobs\//),
  );
  const [w] = writes();
  expect(w.path).toBe(`/api/v1/installs/${i.id}/delete`);
  expect(w.csrf).toBe("mock-csrf");
  expect(w.body).toMatchObject({ confirmSlug: i.slug });
});

it("suspend needs a reason of 1 to 200 characters", async () => {
  const i = installsByState.active;
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
  const dialog = await screen.findByRole("dialog");
  const go = within(dialog).getByRole("button", { name: "Suspend" });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "   " },
  });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "Unpaid invoice" },
  });
  fireEvent.click(go);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].body).toMatchObject({ reason: "Unpaid invoice" });
});

it("upgrade offers other installable releases and sends the choice", async () => {
  const i = installsByState.active;
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  const dialog = await screen.findByRole("dialog");
  // 1.42.0 is installed, so only 1.41.2 is offered besides "latest".
  await within(dialog).findByRole("option", { name: "1.41.2" });
  expect(within(dialog).queryByRole("option", { name: "1.42.0" })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Version"), {
    target: { value: "1.41.2" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].path).toBe(`/api/v1/installs/${i.id}/upgrade`);
  expect(writes()[0].body).toMatchObject({ version: "1.41.2" });
});

it("explains downgrade_refused", async () => {
  const i = installsByState.active;
  use(
    http.post(`*/api/v1/installs/${i.id}/upgrade`, () =>
      apiErr("downgrade_refused", 409),
    ),
  );
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    /older than the one installed/,
  );
});

it("explains job_in_progress and links the running job", async () => {
  const i = installsByState.active;
  use(
    http.post(`*/api/v1/installs/${i.id}/rollback`, () =>
      apiErr("job_in_progress", 409, { jobId: FIXTURE_IDS.jobLeo }),
    ),
  );
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
  expect(
    await screen.findByText(/Another job is already running/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "View the running job" }),
  ).toHaveAttribute("href", `/jobs/${FIXTURE_IDS.jobLeo}`);
});

it("purge sends a signed-out-for-too-long admin to a fresh sign-in", async () => {
  const i = installsByState.failed;
  use(
    http.post(`*/api/v1/installs/${i.id}/purge`, () =>
      apiErr("reauth_required", 403),
    ),
  );
  const assign = vi.fn();
  await open(i);
  vi.stubGlobal("location", {
    ...window.location,
    pathname: `/installs/${i.id}`,
    search: "",
    assign,
  });
  fireEvent.click(screen.getByRole("button", { name: "Purge" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: i.slug },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Purge" }));
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith(
      `/auth/start?reauth=1&return=${encodeURIComponent(`/installs/${i.id}`)}`,
    ),
  );
});

it("retry sends one click with a request id", async () => {
  const i = installsByState.failed;
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].path).toBe(`/api/v1/installs/${i.id}/retry`);
});

it("says a missing install is not found", async () => {
  renderApp("/installs/inothere0001");
  expect(await screen.findByText("Install not found")).toBeInTheDocument();
});
