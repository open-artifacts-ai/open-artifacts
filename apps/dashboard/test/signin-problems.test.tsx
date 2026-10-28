import { type Me, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { installHarness, mount, server } from "./harness";

// Review item 35: a configured sign-in method that's off says why, to the
// owner, in the server's own words.
installHarness();

const EMAIL =
  "Email sign-in is on, but sending email isn't set up (EMAIL and EMAIL_FROM), so sign-in codes aren't offered. Set up email sending, or turn email sign-in off.";
const GOOGLE =
  "Google sign-in is on, but GOOGLE_CLIENT_ID isn't set. Set it, or turn Google sign-in off.";

const withProblems = (problems?: string[]) =>
  server.use(
    http.get(`*${R.me}`, () =>
      HttpResponse.json({
        ...fixtures.me,
        instance: {
          ...fixtures.me.instance,
          signIn: {
            mode: "direct",
            providers: ["google"],
            ...(problems ? { problems } : {}),
          },
        },
      } satisfies Me),
    ),
  );

it("the owner sees each problem verbatim on Instance settings", async () => {
  withProblems([EMAIL, GOOGLE]);
  mount("/settings/instance");
  expect(
    await screen.findByText("Some sign-in methods are off."),
  ).toBeVisible();
  const items = [EMAIL, GOOGLE].map((t) => screen.getByText(t));
  for (const li of items) expect(li.tagName).toBe("LI");
});

it("no note when the list is empty or absent", async () => {
  withProblems([]);
  mount("/settings/instance");
  expect(await screen.findByLabelText("Instance name")).toBeVisible();
  expect(screen.queryByText("Some sign-in methods are off.")).toBeNull();
});

it("no note for an older server that sends no list", async () => {
  withProblems(undefined);
  mount("/settings/instance");
  expect(await screen.findByLabelText("Instance name")).toBeVisible();
  expect(screen.queryByText("Some sign-in methods are off.")).toBeNull();
});
