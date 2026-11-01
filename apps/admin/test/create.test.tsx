import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, it } from "vitest";
import { apiErr, http, renderApp, seen, use, writes } from "./harness";

const type = (slug: string) =>
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: slug } });
const owner = (email = "owner@example.com") =>
  fireEvent.change(screen.getByLabelText("Owner email"), {
    target: { value: email },
  });
const submit = () => screen.getByRole("button", { name: "Create install" });

it("checks the slug rules on the client without calling the API", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  type("Bad_Slug");
  expect(await screen.findByTestId("slug-status")).toHaveTextContent(
    /lowercase/,
  );
  expect(submit()).toBeDisabled();
  type("admin");
  expect(await screen.findByText("That name is reserved.")).toBeInTheDocument();
  type("ab--c");
  expect(await screen.findByTestId("slug-status")).toHaveTextContent(
    /lowercase/,
  );
  expect(seen.some((s) => s.path.includes("/slugs/"))).toBe(false);
});

it("live-checks a valid slug: taken, then available", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  type("leo");
  expect(await screen.findByText("That name is taken.")).toBeInTheDocument();
  expect(submit()).toBeDisabled();
  type("fresh-one");
  owner();
  expect(
    await screen.findByText(
      "fresh-one.open-artifacts-staging.app is available.",
    ),
  ).toBeInTheDocument();
  expect(submit()).toBeEnabled();
});

it("debounces the live check to the last slug typed", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  for (const s of ["a", "ab", "abc"]) type(s);
  await screen.findByText(/ is available\./);
  const checks = seen.filter((s) => s.path.includes("/slugs/"));
  expect(checks.map((c) => c.path)).toEqual(["/api/v1/slugs/abc"]);
});

const release = () => screen.getByRole("combobox", { name: "Release" });

it("offers installable releases with the current one marked", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  await waitFor(() => expect(release()).toHaveTextContent("1.42.0 (latest)"));
  fireEvent.click(release());
  expect(
    await screen.findByRole("option", { name: "1.42.0 (latest)" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "1.41.2" })).toBeInTheDocument();
});

it("creates the install with CSRF, a request id and the chosen version, then opens the job", async () => {
  const { router } = renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  await waitFor(() => expect(release()).toHaveTextContent("1.42.0"));
  fireEvent.click(release());
  fireEvent.click(await screen.findByRole("option", { name: "1.41.2" }));
  await waitFor(() => expect(release()).toHaveTextContent("1.41.2"));
  type("fresh-one");
  owner();
  await screen.findByText(/ is available\./);
  fireEvent.click(submit());
  await waitFor(() =>
    expect(router.state.location.pathname, "never opened the job").toMatch(
      /^\/jobs\//,
    ),
  );
  const [w] = writes();
  expect(w.path).toBe("/api/v1/installs");
  expect(w.csrf).toBe("mock-csrf");
  expect(w.body).toMatchObject({
    slug: "fresh-one",
    version: "1.41.2",
    ownerEmail: "owner@example.com",
    tier: "team",
    auth: { providers: ["google"], domains: ["example.com"] },
  });
  expect((w.body as { requestId: string }).requestId).toMatch(
    /^[A-Za-z0-9_-]{16,64}$/,
  );
});

const domains = (value: string) =>
  fireEvent.change(screen.getByLabelText("Allowed domains"), {
    target: { value },
  });

it("needs at least one allowed domain that includes the owner's, for any sign-in method", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  expect(screen.getByTestId("domains-help")).toHaveTextContent(
    "People with an email at these domains can join. Starts with the owner's domain. Separate with commas.",
  );
  type("fresh-three");
  owner();
  await screen.findByText(/ is available\./);
  expect(screen.getByLabelText("Allowed domains")).toHaveValue("example.com");
  domains("");
  expect(screen.getByTestId("domains-help")).toHaveTextContent(
    "Add at least one domain.",
  );
  expect(screen.getByLabelText("Allowed domains")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(submit()).toBeDisabled();
  expect(submit()).toHaveAccessibleDescription("Fix the allowed domains.");
  domains("a.com, b.org");
  expect(screen.getByTestId("domains-help")).toHaveTextContent(
    "Include the owner's domain, example.com.",
  );
  expect(submit()).toBeDisabled();
  // Email only: the rule still holds.
  fireEvent.click(screen.getByRole("checkbox", { name: "Email" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Google" }));
  expect(screen.getByTestId("domains-help")).toHaveTextContent(
    "Include the owner's domain, example.com.",
  );
  expect(submit()).toBeDisabled();
  domains("a.com, Example.com");
  expect(screen.getByTestId("domains-help")).toHaveTextContent(
    /^People with an email/,
  );
  await waitFor(() => expect(submit()).toBeEnabled());
});

it("says to pick at least one sign-in method", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  type("fresh-five");
  owner();
  await screen.findByText(/ is available\./);
  await waitFor(() => expect(submit()).toBeEnabled());
  expect(screen.queryByTestId("signin-error")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Google" }));
  expect(screen.getByTestId("signin-error")).toHaveTextContent(
    "Pick at least one.",
  );
  expect(submit()).toBeDisabled();
  expect(screen.getByTestId("create-blocker")).toHaveTextContent(
    "Pick a sign-in method.",
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Email" }));
  expect(screen.queryByTestId("signin-error")).toBeNull();
  await waitFor(() => expect(submit()).toBeEnabled());
});

it("sends the providers and domains in the same body shape", async () => {
  const { router } = renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  type("fresh-six");
  owner();
  await screen.findByText(/ is available\./);
  fireEvent.click(screen.getByRole("checkbox", { name: "Email" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Send the owner a welcome email" }),
  );
  domains("example.com, nw-labs.test");
  await waitFor(() => expect(submit()).toBeEnabled());
  fireEvent.click(submit());
  await waitFor(() =>
    expect(router.state.location.pathname).toMatch(/^\/jobs\//),
  );
  expect(writes()[0].body).toMatchObject({
    auth: {
      providers: ["google", "email"],
      domains: ["example.com", "nw-labs.test"],
    },
    sendWelcome: true,
  });
});

it("shows the API's slug_taken answer in plain words", async () => {
  use(http.post("*/api/v1/installs", () => apiErr("slug_taken", 409)));
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  type("fresh-two");
  owner();
  await screen.findByText(/ is available\./);
  await waitFor(() => expect(submit()).toBeEnabled());
  fireEvent.click(submit());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That name is taken.",
  );
});

it("keeps the request id for an unedited resubmit after a dropped connection, and takes a new one once the form is edited", async () => {
  let drop = true;
  use(
    http.post("*/api/v1/installs", () => {
      if (drop) {
        drop = false;
        return HttpResponse.error();
      }
      return apiErr("slug_taken", 409);
    }),
  );
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  type("fresh-id");
  owner();
  await screen.findByText(/ is available\./);
  await waitFor(() => expect(submit()).toBeEnabled());
  const ids = () =>
    writes().map((w) => (w.body as { requestId: string }).requestId);
  fireEvent.click(submit());
  await waitFor(() => expect(writes()).toHaveLength(1));
  await waitFor(() => expect(submit()).toBeEnabled());
  // Same body again: the same request id (the API replays it).
  fireEvent.click(submit());
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(ids()[1]).toBe(ids()[0]);
  // The first network failure is over; this one was answered, so the next is new anyway.
  owner("other@example.com");
  await waitFor(() => expect(submit()).toBeEnabled());
  fireEvent.click(submit());
  await waitFor(() => expect(writes()).toHaveLength(3));
  expect(ids()[2]).not.toBe(ids()[1]);
});

it("a network failure, then an edit: the resubmit has a new request id", async () => {
  use(http.post("*/api/v1/installs", () => HttpResponse.error()));
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  type("fresh-net");
  owner();
  await screen.findByText(/ is available\./);
  await waitFor(() => expect(submit()).toBeEnabled());
  const ids = () =>
    writes().map((w) => (w.body as { requestId: string }).requestId);
  fireEvent.click(submit());
  await waitFor(() => expect(writes()).toHaveLength(1));
  await waitFor(() => expect(submit()).toBeEnabled());
  fireEvent.click(submit());
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(ids()[1]).toBe(ids()[0]);
  owner("edited@example.com");
  await waitFor(() => expect(submit()).toBeEnabled());
  fireEvent.click(submit());
  await waitFor(() => expect(writes()).toHaveLength(3));
  expect(ids()[2]).not.toBe(ids()[1]);
});

it("before typing, the slug help names the host it becomes", async () => {
  renderApp("/installs/new");
  expect(await screen.findByTestId("slug-status")).toHaveTextContent(
    "Becomes <slug>.open-artifacts-staging.app",
  );
});

it("names step 1 Queue the job in What happens", async () => {
  renderApp("/installs/new");
  const aside = await screen.findByRole("complementary", {
    name: "What happens",
  });
  expect(within(aside).getAllByRole("listitem")[0]).toHaveTextContent(
    "Queue the job",
  );
  expect(aside).not.toHaveTextContent("Admit");
});

it("breadcrumb ends at Installs, a link, with no trailing slash", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  const crumbs = document.querySelector<HTMLElement>(".oa-crumbs");
  if (!crumbs) throw new Error("no breadcrumb");
  expect(
    within(crumbs).getByRole("link", { name: "Installs" }),
  ).toHaveAttribute("href", "/installs");
  expect(crumbs.textContent?.trim()).toBe("Installs");
});

it("says why Create install is off until the form is complete", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  expect(screen.getByTestId("create-blocker")).toHaveTextContent("Add a slug.");
  expect(submit()).toBeDisabled();
  expect(submit()).toHaveAccessibleDescription("Add a slug.");
  type("leo");
  expect(await screen.findByText("That name is taken.")).toBeInTheDocument();
  expect(screen.getByTestId("create-blocker")).toHaveTextContent(
    "Pick an available slug.",
  );
  type("fresh-four");
  await screen.findByText(/ is available\./);
  expect(screen.getByTestId("create-blocker")).toHaveTextContent(
    "Add an owner email.",
  );
  owner("not-an-email");
  expect(screen.getByTestId("create-blocker")).toHaveTextContent(
    "Enter a valid owner email.",
  );
  owner();
  await waitFor(() =>
    expect(screen.queryByTestId("create-blocker")).not.toBeInTheDocument(),
  );
  expect(submit()).toBeEnabled();
});
