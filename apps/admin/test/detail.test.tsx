import type { InstallDetail, InstallState } from "@oa/provisioning-contract";
import { fixtureMe } from "@oa/provisioning-contract/fixtures";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  FIXTURE_IDS,
  installsByState,
  jobsByStatus,
} from "../src/mocks/fixtures";
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
  active: ["Upgrade", "Roll back", "Pause", "Delete"],
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

it("shows Design's labels, the pause reason and the fields", async () => {
  await open(installsByState.suspended);
  expect(screen.getByText(/Reason: Unpaid invoice/)).toBeInTheDocument();
  expect(screen.getByText("owner@example.com")).toBeInTheDocument();
  expect(screen.getByText("Tier · Sign-in")).toBeInTheDocument();
  expect(screen.getByText("Team · Google · 1 domain")).toBeInTheDocument();
  expect(screen.getByText("Install id")).toBeInTheDocument();
  expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
});

it("reads the upgrade target from args.version", async () => {
  const i = { ...installsByState.active, activeJobId: FIXTURE_IDS.jobLeo };
  use(
    http.get(`*/api/v1/jobs/${FIXTURE_IDS.jobLeo}`, () =>
      json({ ...jobsByStatus.running, args: { version: "1.43.0" } }),
    ),
  );
  await open(i);
  expect(await screen.findByTestId("active-job")).toHaveTextContent(
    "Upgrading to 1.43.0, step 5 of 5, Health check.",
  );
});

it("unlocks the actions when the active job settles", async () => {
  const i = { ...installsByState.active, activeJobId: FIXTURE_IDS.jobLeo };
  let settled = false;
  use(
    http.get(`*/api/v1/installs/${i.id}`, () =>
      json(settled ? { ...i, activeJobId: null } : i),
    ),
    http.get(`*/api/v1/jobs/${FIXTURE_IDS.jobLeo}`, () => {
      settled = true;
      return json(jobsByStatus.done);
    }),
  );
  renderApp(`/installs/${i.id}`);
  await screen.findByRole("heading", { name: i.slug });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled(),
  );
});

it("explains a routing mismatch and a rolled-back upgrade", async () => {
  const i = { ...installsByState.active, mismatch: "mode_paused" };
  use(
    http.get(`*/api/v1/installs/${i.id}/jobs`, () =>
      json({
        items: [
          {
            ...jobsByStatus.failed,
            lastErrorCode: "upgrade_rolled_back",
            args: { version: "1.43.0" },
          },
        ],
        nextCursor: null,
      }),
    ),
  );
  await open(i);
  expect(screen.getByTestId("mismatch")).toHaveTextContent(
    "Routing doesn't match.",
  );
  const b = await screen.findByTestId("rolled-back");
  expect(b).toHaveTextContent("Serving 1.42.0, not 1.43.0.");
  expect(b).toHaveTextContent("The last upgrade rolled back.");
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

for (const force of [false, true]) {
  it(`release lease ${force ? "sends" : "does not send"} force when the Force box is ${force ? "ticked" : "left off"}`, async () => {
    const i = {
      ...installsByState.active,
      lease: { held: true, until: Date.now() + 3_600_000 },
    };
    await open(i);
    fireEvent.click(screen.getByRole("button", { name: "Release lease" }));
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByRole("checkbox", { name: /Force/ });
    expect(box).not.toBeChecked();
    if (force) fireEvent.click(box);
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: i.slug },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Release lease" }),
    );
    await waitFor(() => expect(writes()).toHaveLength(1));
    const body = writes()[0].body as Record<string, unknown>;
    expect(body.confirmSlug).toBe(i.slug);
    expect("force" in body).toBe(force);
  });
}

it("offers Force only while the lease is live", async () => {
  const i = {
    ...installsByState.active,
    lease: { held: true, until: Date.now() - 1000 },
  };
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Release lease" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
});

it("hides Restore when the grace window is over", async () => {
  await open({ ...installsByState.deleting, restorable: false });
  expect(buttons()).toEqual(["Purge"]);
});

it("links the active job and disables the lifecycle actions", async () => {
  await open({ ...installsByState.active, activeJobId: FIXTURE_IDS.jobLeo });
  expect(screen.getByRole("link", { name: "Open job" })).toHaveAttribute(
    "href",
    `/jobs/${FIXTURE_IDS.jobLeo}`,
  );
  expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel job" })).toBeEnabled();
});

it("delete is type-to-confirm on the slug", async () => {
  const i = installsByState.active;
  const { router } = await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog");
  const go = within(dialog).getByRole("button", { name: "Delete leo" });
  expect(go).toBeDisabled();
  // A disabled confirm says why, and the button points at that line.
  const why = within(dialog).getByTestId("dialog-blocker");
  expect(why).toHaveTextContent("Type leo to confirm.");
  expect(go).toHaveAttribute("aria-describedby", why.id);
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "wrong" },
  });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: i.slug },
  });
  expect(go).toBeEnabled();
  expect(within(dialog).queryByTestId("dialog-blocker")).toBeNull();
  expect(go).not.toHaveAttribute("aria-describedby");
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
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  const dialog = await screen.findByRole("dialog");
  const go = within(dialog).getByRole("button", { name: "Pause leo" });
  expect(go).toBeDisabled();
  expect(within(dialog).getByTestId("dialog-blocker")).toHaveTextContent(
    "Add a reason.",
  );
  const reason = within(dialog).getByRole("textbox", { name: "Reason" });
  // One line, capped at 200 characters.
  expect(reason.tagName).toBe("INPUT");
  expect(reason).toHaveAttribute("maxlength", "200");
  fireEvent.change(reason, { target: { value: "   " } });
  expect(go).toBeDisabled();
  fireEvent.change(reason, { target: { value: "Unpaid invoice" } });
  expect(within(dialog).queryByTestId("dialog-blocker")).toBeNull();
  fireEvent.click(go);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].body).toMatchObject({ reason: "Unpaid invoice" });
});

const rel = (version: string) => ({
  version,
  publishedAt: 1,
  variants: ["release"],
  installable: true,
  latest: false,
});
const serveReleases = (platform: string | null, versions: string[]) =>
  use(
    http.get("*/api/v1/releases", () =>
      json({ items: versions.map(rel), platform }),
    ),
  );
const openUpgrade = async (i: InstallDetail) => {
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  const dialog = await screen.findByRole("dialog");
  return {
    dialog,
    version: within(dialog).getByRole("combobox", { name: "Version" }),
    submit: within(dialog).getByRole("button", { name: "Upgrade" }),
  };
};
const AHEAD = "Newer than the platform (1.42.0). Not deployed yet.";
const PAUSED =
  "The platform has no stable release yet, so upgrades are paused.";

it("upgrade lists only releases newer than the install and sends the choice", async () => {
  // The API refuses one at or below the install's own (downgrade_refused).
  serveReleases("1.42.0", ["1.42.0", "1.41.2", "1.40.0", "1.39.0"]);
  const i = { ...installsByState.active, version: "1.40.0" };
  const { dialog, version, submit } = await openUpgrade(i);
  await waitFor(() =>
    expect(version).toHaveTextContent("The platform's release"),
  );
  fireEvent.click(version);
  await screen.findByRole("option", { name: "1.41.2" });
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "The platform's release",
    "1.42.0",
    "1.41.2",
  ]);
  fireEvent.click(screen.getByRole("option", { name: "1.41.2" }));
  await waitFor(() => expect(version).toHaveTextContent("1.41.2"));
  expect(within(dialog).queryByTestId("dialog-blocker")).toBeNull();
  fireEvent.click(submit);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].path).toBe(`/api/v1/installs/${i.id}/upgrade`);
  expect(writes()[0].body).toMatchObject({ version: "1.41.2" });
});

it("upgrade disables releases newer than the platform, with the reason", async () => {
  serveReleases("1.42.0", ["1.44.0", "1.43.1", "1.42.0", "1.41.2"]);
  const i = { ...installsByState.active, version: "1.41.2" };
  const { version, submit } = await openUpgrade(i);
  await waitFor(() =>
    expect(version).toHaveTextContent("The platform's release"),
  );
  fireEvent.click(version);
  await screen.findByRole("option", { name: "1.42.0" });
  // Each item's text: the version, then the reason when it has one.
  const byText = (t: string) => {
    const o = screen.getAllByRole("option").find((x) => x.textContent === t);
    if (!o) throw new Error(`no option "${t}"`);
    return o;
  };
  const newer = byText(`1.44.0 ${AHEAD}`);
  expect(newer).toHaveAttribute("aria-disabled", "true");
  expect(byText(`1.43.1 ${AHEAD}`)).toHaveAttribute("aria-disabled", "true");
  // At the platform's release: allowed, and no reason beside it.
  const same = screen.getByRole("option", { name: "1.42.0" });
  expect(same).not.toHaveAttribute("aria-disabled");
  expect(
    screen.getByRole("option", { name: "The platform's release" }),
  ).not.toHaveAttribute("aria-disabled");
  // A click on a disabled item picks nothing.
  fireEvent.click(newer);
  expect(version).toHaveTextContent("The platform's release");
  fireEvent.click(same);
  await waitFor(() => expect(version).toHaveTextContent("1.42.0"));
  fireEvent.click(submit);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].body).toMatchObject({ version: "1.42.0" });
});

it("upgrade with no platform release: everything disabled, one note, no submit", async () => {
  serveReleases(null, ["1.42.0", "1.41.2"]);
  const i = { ...installsByState.active, version: "1.40.0" };
  const { dialog, version, submit } = await openUpgrade(i);
  expect(await within(dialog).findByText(PAUSED)).toBeVisible();
  expect(version).toHaveAccessibleDescription(PAUSED);
  // The default would be the platform's release, which is off too: none is picked.
  expect(version).toHaveTextContent("No release available");
  expect(submit).toBeDisabled();
  fireEvent.click(version);
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "The platform's release",
    "1.42.0",
    "1.41.2",
  ]);
  for (const o of options) expect(o).toHaveAttribute("aria-disabled", "true");
  // One note in the dialog, not one per item.
  expect(within(dialog).getAllByText(PAUSED)).toHaveLength(1);
  expect(writes()).toEqual([]);
});

it("upgrade with the platform's release: no note and no reasons", async () => {
  serveReleases("1.42.0", ["1.42.0", "1.41.2"]);
  const i = { ...installsByState.active, version: "1.40.0" };
  const { dialog, version } = await openUpgrade(i);
  await waitFor(() =>
    expect(version).toHaveTextContent("The platform's release"),
  );
  expect(within(dialog).queryByText(PAUSED)).toBeNull();
  fireEvent.click(version);
  for (const o of await screen.findAllByRole("option"))
    expect(o).not.toHaveAttribute("aria-disabled");
  expect(screen.queryByText(/Newer than the platform/)).toBeNull();
});

it("upgrade hides the platform's release when the install is already on it or newer", async () => {
  // R5's default takes the platform's release: at or below the install's own, downgrade_refused.
  serveReleases("1.42.0", ["1.43.0", "1.42.0"]);
  const i = { ...installsByState.active, version: "1.42.0" };
  const { dialog, version, submit } = await openUpgrade(i);
  // 1.43.0 is ahead of the platform, so nothing is left to pick.
  await waitFor(() =>
    expect(version).toHaveTextContent("No release available"),
  );
  expect(submit).toBeDisabled();
  expect(within(dialog).getByTestId("dialog-blocker")).toHaveTextContent(
    "No release can be picked yet.",
  );
  fireEvent.click(version);
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual([`1.43.0 ${AHEAD}`]);
  expect(writes()).toEqual([]);
});

it("sends nonAdditive only when the restore point box is ticked (MIG-2)", async () => {
  // Below the platform's release, so the default is offered.
  const i = { ...installsByState.active, version: "1.40.0" };
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  let dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].body).not.toHaveProperty("nonAdditive");
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: /migration that can lose/ }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1].body).toMatchObject({ nonAdditive: true });
});

it("explains downgrade_refused", async () => {
  // Below the platform's release, so the default is offered.
  const i = { ...installsByState.active, version: "1.40.0" };
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

it("a deleting install's purge asks for a fresh sign-in first", async () => {
  const i = installsByState.deleting;
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
  expect(dialog).toHaveTextContent("Delete deleting for good?");
  expect(dialog).toHaveTextContent("Sign in again to continue.");
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Sign in again" }),
  );
  expect(assign).toHaveBeenCalledWith(
    `/auth/start?reauth=1&return=${encodeURIComponent(`/installs/${i.id}`)}`,
  );
  expect(writes()).toHaveLength(0);
});

it("a failed create's purge goes straight to type-to-confirm, even when the sign-in is old", async () => {
  const i = installsByState.failed;
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Purge" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).not.toHaveTextContent("Sign in again");
  const go = within(dialog).getByRole("button", {
    name: `Delete ${i.slug} for good`,
  });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: i.slug },
  });
  fireEvent.click(go);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].path).toBe(`/api/v1/installs/${i.id}/purge`);
});

it("a missing tier reads – as in the list", async () => {
  await open({ ...installsByState.active, tier: null });
  const row = (await screen.findByText("Tier · Sign-in")).parentElement;
  expect(row).toHaveTextContent(/^Tier · Sign-in– · /);
  expect(row).not.toHaveTextContent("None");
});

it("purge with a fresh sign-in is type-to-confirm", async () => {
  const i = installsByState.failed;
  use(
    http.get("*/api/v1/me", () =>
      json({
        ...fixtureMe({
          principal: "admin",
          csrf: "mock-csrf",
          tokenId: null,
          tokenKind: null,
          tokenExpiresAt: null,
        }),
        authAt: Date.now() - 60_000,
      }),
    ),
  );
  await open(i);
  fireEvent.click(screen.getByRole("button", { name: "Purge" }));
  const dialog = await screen.findByRole("dialog");
  // The title and the confirm use the same verb.
  expect(
    within(dialog).getByRole("heading", { name: `Delete ${i.slug} for good?` }),
  ).toBeInTheDocument();
  const go = within(dialog).getByRole("button", {
    name: `Delete ${i.slug} for good`,
  });
  expect(go).toBeDisabled();
  expect(within(dialog).getByTestId("dialog-blocker")).toHaveTextContent(
    `Type ${i.slug} to confirm.`,
  );
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: i.slug },
  });
  fireEvent.click(go);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].path).toBe(`/api/v1/installs/${i.id}/purge`);
  expect(writes()[0].body).toMatchObject({ confirmSlug: i.slug });
});

it("still sends the user to sign in again when the API says reauth_required", async () => {
  const i = installsByState.failed;
  use(
    http.get("*/api/v1/me", () =>
      json({
        ...fixtureMe({
          principal: "admin",
          csrf: "mock-csrf",
          tokenId: null,
          tokenKind: null,
          tokenExpiresAt: null,
        }),
        authAt: Date.now() - 60_000,
      }),
    ),
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
  fireEvent.click(
    within(dialog).getByRole("button", { name: `Delete ${i.slug} for good` }),
  );
  await waitFor(() => expect(assign).toHaveBeenCalled());
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

it("the head: breadcrumb ends at Installs, the state chip sits by the title, the host under it", async () => {
  const i = installsByState.active;
  await open(i);
  const crumbs = document.querySelector(".oa-crumbs") as HTMLElement;
  expect(
    within(crumbs).getByRole("link", { name: "Installs" }),
  ).toHaveAttribute("href", "/installs");
  // Ends at the parent: no trailing "/".
  expect(crumbs.textContent).toBe("Installs");
  const head = screen.getByRole("heading", { name: i.slug }).parentElement;
  expect(within(head as HTMLElement).getByTestId("state")).toHaveTextContent(
    "Active",
  );
  expect(screen.getByText(i.appHost)).toBeInTheDocument();
});

it("every action is an outline button; only the confirm in the dialog is red", async () => {
  await open(installsByState.active);
  const region = screen.getByRole("region", { name: "Actions" });
  for (const b of within(region).getAllByRole("button"))
    expect(b).toHaveAttribute("data-variant", "outline");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByRole("button", { name: "Delete leo" }),
  ).toHaveAttribute("data-variant", "destructive");
});

it("a failed install keeps its banner, with Retry and Purge as outline buttons", async () => {
  await open(installsByState.failed);
  expect(
    await screen.findByText(
      /The last job failed. Retry it or purge the install./,
    ),
  ).toBeInTheDocument();
  for (const name of ["Retry", "Purge"])
    expect(screen.getByRole("button", { name })).toHaveAttribute(
      "data-variant",
      "outline",
    );
});

it("recent jobs: a section title over a table of job, step, state, start and actor", async () => {
  await open(installsByState.active);
  expect(
    screen.getByRole("heading", { name: "Recent jobs", level: 2 }),
  ).toBeInTheDocument();
  const table = await screen.findByRole("table");
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["Job", "Step", "State", "Started", "By"]);
  const row = within(table).getAllByRole("row")[1];
  expect(within(row).getByRole("link")).toHaveAttribute(
    "href",
    expect.stringMatching(/^\/jobs\//),
  );
  // The job state is Design's label, never the raw enum.
  expect(within(row).getByTestId("status").textContent).toMatch(
    /^(Queued|Running|Done|Failed)$/,
  );
});

it("recent jobs: says No jobs yet. when there are none", async () => {
  const i = installsByState.active;
  use(
    http.get(`*/api/v1/installs/${i.id}/jobs`, () =>
      json({ items: [], nextCursor: null }),
    ),
  );
  await open(i);
  expect(await screen.findByText("No jobs yet.")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});
