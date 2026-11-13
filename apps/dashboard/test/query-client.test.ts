import { fixtures } from "@oa/shared/mocks";
import { expect, it, vi } from "vitest";
import { ApiClientError } from "../src/api/client";
import { qk } from "../src/api/queries";
import { makeQueryClient, reportApiError } from "../src/api/queryClient";

it("a 401 reauth_required does not sign the owner out", async () => {
  const client = makeQueryClient();
  client.setQueryData(qk.me, fixtures.me);
  const e = Object.assign(
    new ApiClientError("reauth_required", "Log in again", 401),
    { method: "GET", path: "/api/v1/directory" },
  );
  reportApiError(client, e);
  // A plain 401 lands asynchronously (after cancelQueries); give it the chance.
  await new Promise((r) => setTimeout(r, 20));
  expect(client.getQueryState(qk.me)?.status).toBe("success");
});

it("any other 401 still marks /me failed", async () => {
  const client = makeQueryClient();
  client.setQueryData(qk.me, fixtures.me);
  reportApiError(
    client,
    Object.assign(new ApiClientError("unauthorized", "Log in", 401), {
      method: "GET",
      path: "/api/v1/artifacts",
    }),
  );
  await vi.waitFor(() =>
    expect(client.getQueryState(qk.me)?.status).toBe("error"),
  );
});

it.each([
  "/api/v1/directory",
  "/api/v1/directory/groups",
  "/api/v1/directory/restricted-groups/gCon04",
  "/api/v1/spaces/SpEngNpQrSt2uVwX/mappings",
  "/api/v1/audit",
])("a 404 from %s refreshes /me", (path) => {
  const client = makeQueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  reportApiError(
    client,
    Object.assign(new ApiClientError("not_found", "Not found", 404), {
      method: "GET",
      path,
    }),
  );
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.me, exact: true });
});

it.each([
  "/api/v1/spaces",
  "/api/v1/spaces/SpEngNpQrSt2uVwX",
  "/api/v1/artifacts/x",
])("a 404 from %s leaves /me alone", (path) => {
  const client = makeQueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  reportApiError(
    client,
    Object.assign(new ApiClientError("not_found", "Not found", 404), {
      method: "GET",
      path,
    }),
  );
  expect(spy).not.toHaveBeenCalled();
});
