import { fireEvent, screen, waitFor } from "@testing-library/react";
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

it("offers installable releases with the current one marked", async () => {
  renderApp("/installs/new");
  const select = await screen.findByLabelText("Release");
  await waitFor(() => expect(select).toHaveValue("1.42.0"));
  expect(
    screen.getByRole("option", { name: "1.42.0 (latest)" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "1.41.2" })).toBeInTheDocument();
});

it("creates the install with CSRF, a request id and the chosen version, then opens the job", async () => {
  const { router } = renderApp("/installs/new");
  await waitFor(() =>
    expect(screen.getByLabelText("Release")).toHaveValue("1.42.0"),
  );
  fireEvent.change(screen.getByLabelText("Release"), {
    target: { value: "1.41.2" },
  });
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

it("needs a sign-in domain when Google is on", async () => {
  renderApp("/installs/new");
  await screen.findByLabelText("Slug");
  type("fresh-three");
  owner();
  await screen.findByText(/ is available\./);
  fireEvent.change(screen.getByLabelText("Allowed domains"), {
    target: { value: "" },
  });
  expect(submit()).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Allowed domains"), {
    target: { value: "a.com, b.org" },
  });
  expect(submit()).toBeEnabled();
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
