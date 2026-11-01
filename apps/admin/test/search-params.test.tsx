// Search values reach the routes as the strings in the URL (#1026): Google
// `sub`s are all digits, and TanStack's default parser made them numbers.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { rawSearch } from "../src/router";
import { renderApp, seen } from "./harness";

const SUB = "112233445566778899001"; // 21 digits, past 2^53

it("/no-access shows a 21-digit sub exactly and keeps it in the URL", async () => {
  const { router } = renderApp(`/no-access?error=unknown_sub&sub=${SUB}`);
  expect(await screen.findByText(SUB)).toBeInTheDocument();
  expect(screen.getByText(SUB).closest(".oa-idrow")).toHaveTextContent(
    `Account id${SUB}`,
  );
  expect(router.state.location.search).toEqual({
    error: "unknown_sub",
    sub: SUB,
  });
});

it("/no-access shows a short all-digit sub", async () => {
  renderApp("/no-access?error=unknown_sub&sub=1234567890");
  expect(await screen.findByText("1234567890")).toBeInTheDocument();
});

it("/audit keeps a numeric actor and a true-looking action as strings", async () => {
  const { router } = renderApp(`/audit?actor=${SUB}&action=true`);
  expect(await screen.findByLabelText("Actor")).toHaveTextContent(SUB);
  expect(router.state.location.search).toEqual({ actor: SUB, action: "true" });
  await waitFor(() =>
    expect(seen.some((s) => s.path.includes(`actor=${SUB}`))).toBe(true),
  );
});

it("a digit filter round-trips through the URL unquoted", async () => {
  const { router } = renderApp("/audit");
  await screen.findByLabelText("Actor");
  await router.navigate({ to: "/audit", search: { actor: "007" } });
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ actor: "007" }),
  );
  expect(router.state.location.searchStr).toBe("?actor=007");
});

it("the codec keeps every value a string", () => {
  expect(
    rawSearch.parseSearch(`?sub=${SUB}&a=1&b=true&c=null&d=%22q%22`),
  ).toEqual({ sub: SUB, a: "1", b: "true", c: "null", d: '"q"' });
  expect(rawSearch.stringifySearch({ sub: SUB, a: "1", x: undefined })).toBe(
    `?sub=${SUB}&a=1`,
  );
});
