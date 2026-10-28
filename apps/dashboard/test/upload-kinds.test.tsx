import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { installHarness, mount, server } from "./harness";

// What upload opens, shown before a file is picked (Design, #780).
installHarness();

// Radix Tooltip measures its content; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const KINDS = "Web pages, Markdown, code and PDFs";
const empty = http.get(`*${R.artifacts}`, () =>
  HttpResponse.json({ items: [], nextCursor: null }),
);

it("an empty library lists what upload opens, for someone who can upload", async () => {
  server.use(empty);
  mount("/");
  expect(await screen.findByText("No artifacts yet")).toBeVisible();
  expect(screen.getByText(KINDS)).toBeVisible();
});

it("a guest's empty Shared with me doesn't", async () => {
  server.use(
    empty,
    http.get(`*${R.me}`, () =>
      HttpResponse.json({
        ...fixtures.me,
        user: { ...fixtures.me.user, role: "guest" },
      }),
    ),
  );
  mount("/shared");
  expect(await screen.findByText("Nothing shared with you yet")).toBeVisible();
  expect(screen.queryByText(KINDS)).toBeNull();
});

it("Upload files has the kinds as its tooltip", async () => {
  mount("/");
  const button = await screen.findByRole("button", { name: "Upload files" });
  fireEvent.focus(button);
  expect((await screen.findAllByText(KINDS)).length).toBeGreaterThan(0);
});
