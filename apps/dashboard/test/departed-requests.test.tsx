// The departed-people dot (useDeparted, in AppLayout and SettingsLayout) asks
// R.memberTransfer only for members the list marks `transferable`: never one
// request per departed member on every load (v0.187.0 T19: 92 on one install).
import { type Member, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { calls, installHarness, lastClient, mountHosted } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

/** 40 departed members, the first `n` with artifacts left. */
const gone = (n: number): Member[] =>
  Array.from({ length: 40 }, (_, i) => ({
    id: `Gone${String(i).padStart(4, "0")}AbCdEfGh`,
    email: `gone${i}@example.com`,
    name: `Gone ${i}`,
    role: "member" as const,
    lastSeenAt: null,
    status: i % 2 ? ("removed" as const) : ("suspended" as const),
    identities: [],
    ...(i < n ? { transferable: true } : {}),
  }));

const load = async (n: number) => {
  const gets = calls("GET");
  mountHosted("/", true, undefined, [
    http.get(`*${R.members}`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("status")
          ? gone(n)
          : fixtures.members,
      ),
    ),
    http.get("*/api/v1/members/:id/transfer", () =>
      HttpResponse.json({ live: 1, deleted: 0 }),
    ),
  ]);
  await screen.findByRole(
    "button",
    { name: "Account menu" },
    { timeout: FIRST_LOAD_MS },
  );
  // The departed list has loaded (the dot depends on it).
  await waitFor(() =>
    expect(
      gets.some((c) => c.path === R.members && c.search.get("status") !== null),
    ).toBe(true),
  );
  // Every query the list started (summaries included) has settled.
  await waitFor(() => expect(lastClient.isFetching()).toBe(0));
  return () =>
    gets.filter((c) => /^\/api\/v1\/members\/[^/]+\/transfer$/.test(c.path));
};

describe("departed people on every load", () => {
  it("asks for a summary only for the transferable ones", async () => {
    const transfers = await load(2);
    expect(transfers()).toHaveLength(2);
    expect(transfers().map((c) => c.path)).toEqual(
      expect.arrayContaining([
        R.memberTransfer("Gone0000AbCdEfGh"),
        R.memberTransfer("Gone0001AbCdEfGh"),
      ]),
    );
    // The Settings dot still shows for them.
    expect(
      await screen.findByRole("link", { name: /Settings, needs attention/ }),
    ).toBeInTheDocument();
  });

  it("asks for none when no one has artifacts left", async () => {
    const transfers = await load(0);
    expect(transfers()).toHaveLength(0);
  });
});
