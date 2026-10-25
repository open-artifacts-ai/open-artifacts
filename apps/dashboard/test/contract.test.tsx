// Hosted P4 Task 1: the contract adapter, the hosted harness and the ?hosted= mock switch.
import type { Me } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  canOf,
  directoryMode,
  features,
  hasFeature,
  readAuthProviders,
} from "../src/api/contract";
import { parseHostedParam } from "../src/hostedParam";
import {
  calls,
  installHarness,
  lastClient,
  mount,
  mountHosted,
} from "./harness";

installHarness();

test("me without hosted fields has no features", () => {
  expect(features(fixtures.me)).toEqual([]);
  expect(hasFeature(fixtures.me, "spaces")).toBe(false);
});

test("directoryMode is the server's rule on the flags: google wins, then frozen, else off", () => {
  const withFlags = (...f: string[]) =>
    ({
      ...fixtures.me,
      instance: { ...fixtures.me.instance, features: f },
    }) as unknown as Me;
  expect(directoryMode(fixtures.me)).toBe("off");
  expect(directoryMode(undefined)).toBe("off");
  expect(directoryMode(withFlags("spaces"))).toBe("off");
  expect(directoryMode(withFlags("spaces", "sync_google"))).toBe("google");
  expect(directoryMode(withFlags("spaces", "sync_frozen"))).toBe("frozen");
  expect(directoryMode(withFlags("sync_frozen", "sync_google"))).toBe("google");
});

test("canOf derives the action table when the server omits can", () => {
  const a = {
    ...fixtures.artifacts[0],
    access: "editor" as const,
    can: undefined,
  };
  expect(canOf(a, [])).toEqual({
    edit: true,
    share: false,
    setVisibility: false,
    delete: false,
    transfer: false,
    move: false,
    dataWrite: true,
  });
});

test("self-hosted owner: no move or transfer", () => {
  const a = {
    ...fixtures.artifacts[0],
    access: "owner" as const,
    can: undefined,
  };
  expect(canOf(a, [])).toMatchObject({
    share: true,
    setVisibility: true,
    delete: true,
    move: false,
    transfer: false,
  });
  expect(canOf(a, ["spaces"])).toMatchObject({ move: true, transfer: true });
});

test("canOf keeps the server's can when spaces are on", () => {
  const can = {
    edit: true,
    share: true,
    setVisibility: true,
    delete: true,
    transfer: false,
    move: true,
    dataWrite: true,
  };
  expect(canOf({ ...fixtures.artifacts[0], can }, ["spaces"])).toEqual(can);
});

test("readAuthProviders falls back to access mode", () => {
  expect(readAuthProviders(undefined)).toEqual({
    mode: "access",
    providers: [{ id: "access", start: "/auth/login" }],
  });
});

test("hosted param tokens", () => {
  expect(parseHostedParam(null)).toBeUndefined();
  expect(parseHostedParam("1")).toEqual({});
  expect(parseHostedParam("team,frozen,unhealthy")).toEqual({
    tier: "team",
    directory: "frozen",
    unhealthy: true,
  });
  expect(parseHostedParam("access")).toEqual({ mode: "access" });
  expect(parseHostedParam("email-only,turnstile")).toEqual({
    providers: ["email"],
    turnstile: true,
  });
  expect(parseHostedParam("auth-failed")).toEqual({
    unhealthy: true,
    unhealthyState: "auth_failed",
  });
  expect(parseHostedParam("scope-missing")?.unhealthyState).toBe(
    "scope_missing",
  );
  expect(parseHostedParam("customer-mismatch")?.unhealthyState).toBe(
    "customer_mismatch",
  );
});

test("no features: no hosted request from signed-in pages", async () => {
  const seen = calls();
  mount("/");
  await screen.findAllByText("Landing page");
  for (const p of ["/api/v1/spaces", "/api/v1/directory", "/auth/providers"])
    expect(seen.some((c) => c.path.startsWith(p))).toBe(false);
});

test("hosted mock me carries the hosted fields", async () => {
  mountHosted("/", { tier: "team", directory: "frozen" });
  const me = await waitFor(() => {
    const m = lastClient.getQueryData<Me>(["me"]);
    if (!m) throw new Error("no me yet");
    return m;
  });
  expect(me.personalSpaceId).toBe("Ab3dEfGhJk4mNpQr");
  expect(me.instance.tier).toBe("team");
  expect(me.instance.directory?.mode).toBe("frozen");
  expect(me.spaces?.map((s) => [s.name, s.myRole])).toEqual([
    ["Engineering", "manager"],
    ["Exec", "viewer"],
  ]);
});

test("mountHosted: overrides win and me rewrites the hosted /me", async () => {
  mountHosted("/", true, (m) => ({ ...m, displayName: "Rewritten" }));
  await waitFor(() =>
    expect(lastClient.getQueryData<Me>(["me"])?.displayName).toBe("Rewritten"),
  );
  expect(lastClient.getQueryData<Me>(["me"])?.instance.features).toContain(
    "spaces",
  );
});
