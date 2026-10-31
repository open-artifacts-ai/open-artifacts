import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoAccess } from "../src/pages/NoAccess";
import { adminMe, apiError } from "./me";

afterEach(() => vi.unstubAllGlobals());

const stub = (...responses: Response[]) => {
  const assign = vi.fn();
  vi.stubGlobal("location", {
    ...window.location,
    pathname: "/no-access",
    search: "",
    assign,
  });
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetchMock);
  return { assign, fetchMock };
};

it("not_listed shows copy and makes no API call", () => {
  const { fetchMock } = stub();
  render(<NoAccess error="not_listed" />);
  expect(screen.getByRole("alert")).toHaveTextContent(/not on the admin list/);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("unknown_sub shows the account id", () => {
  render(<NoAccess error="unknown_sub" sub="1234567890" />);
  expect(screen.getByText("1234567890")).toBeInTheDocument();
});

it("an unknown error and a hostile sub fall back to plain copy", () => {
  render(<NoAccess error="<b>" sub="<b>x</b>" />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This account is not on the admin list.",
  );
  expect(screen.queryByText("<b>x</b>")).toBeNull();
});

it("Use another account with no session (me 401): no logout, no loop, goes to start", async () => {
  const { assign, fetchMock } = stub(
    new Response(JSON.stringify(apiError("unauthenticated")), { status: 401 }),
  );
  render(<NoAccess error="not_listed" />);
  fireEvent.click(screen.getByRole("button", { name: "Use another account?" }));
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith("/auth/start?return=%2Finstalls"),
  );
  expect(assign).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("Use another account while signed in: logout with CSRF first, then start", async () => {
  const { assign, fetchMock } = stub(
    new Response(JSON.stringify(adminMe("tok"))),
    new Response(null, { status: 204 }),
  );
  render(<NoAccess error="not_listed" />);
  fireEvent.click(screen.getByRole("button", { name: "Use another account?" }));
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith("/auth/start?return=%2Finstalls"),
  );
  const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(url).toBe("/auth/logout");
  expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("tok");
});
