// A full doc offers New doc only to someone the Library would offer it to
// (docs on, may create). Was e2e/doc-full.spec.ts (#2711).
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { qk } from "../src/api/queries";
import { makeQueryClient } from "../src/api/queryClient";
import { FullDocNewDoc } from "../src/library/NewDoc";
import { installHarness, server } from "./harness";

installHarness();

type Me = typeof fixtures.me;

const show = (patch: (m: Me) => Me) => {
  const me = patch({
    ...fixtures.me,
    instance: { ...fixtures.me.instance, docs: "on" },
  });
  server.use(http.get("*/api/v1/me", () => HttpResponse.json(me)));
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <FullDocNewDoc spaceOf={undefined} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = makeQueryClient();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
};
const button = () => screen.queryByRole("button", { name: "New doc" });

/** Nothing renders while /me loads: wait for its answer, then look. */
const settled = (client: ReturnType<typeof makeQueryClient>) =>
  waitFor(() => expect(client.getQueryData(qk.me)).toBeDefined());

describe("FullDocNewDoc", () => {
  it("a member sees New doc beside the full message", async () => {
    show((m) => m);
    expect(
      await screen.findByRole("button", { name: "New doc" }),
    ).toBeVisible();
  });

  it("a guest does not", async () => {
    const c = show((m) => ({ ...m, user: { ...m.user, role: "guest" } }));
    await settled(c);
    expect(button()).toBeNull();
  });

  it("a read-only cap does not", async () => {
    const c = show((m) => ({
      ...m,
      auth: { method: "google", readOnly: true, cap: "plan", expiresAt: null },
    }));
    await settled(c);
    expect(button()).toBeNull();
  });

  it("an instance whose docs need Workers Paid does not", async () => {
    const c = show((m) => ({
      ...m,
      instance: { ...m.instance, docs: "needs_paid" },
    }));
    await settled(c);
    expect(button()).toBeNull();
  });
});
