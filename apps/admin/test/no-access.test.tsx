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
  expect(screen.getByRole("alert")).toHaveTextContent(/isn't a platform admin/);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("unknown_sub asks to link, with the account id and a Copy button", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<NoAccess error="unknown_sub" sub="112233445566778899001" />);
  expect(
    screen.getByRole("heading", { name: "No access yet" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your email is on the admin list. Send an admin the account id below so they can link this Google account.",
  );
  expect(screen.getByText("Account id")).toBeInTheDocument();
  expect(screen.getByText("112233445566778899001")).toHaveClass("oa-mono");
  fireEvent.click(screen.getByRole("button", { name: "Copy account id" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("112233445566778899001"),
  );
  expect(
    await screen.findByRole("button", { name: "Copy account id" }),
  ).toHaveTextContent("Copied");
  expect(
    screen.getByRole("button", { name: "Use another account" }),
  ).toHaveAttribute("data-variant", "outline");
});

it("not_listed keeps its title and copy, with no account id row", () => {
  render(<NoAccess error="not_listed" sub="1234567890" />);
  expect(
    screen.getByRole("heading", { name: "No access" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Account id")).toBeNull();
});

it("an unknown error and a hostile sub fall back to plain copy", () => {
  render(<NoAccess error="<b>" sub="<b>x</b>" />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This account isn't a platform admin.",
  );
  expect(screen.queryByText("<b>x</b>")).toBeNull();
});

it("Use another account with no session (me 401): no logout, no loop, goes to start", async () => {
  const { assign, fetchMock } = stub(
    new Response(JSON.stringify(apiError("unauthenticated")), { status: 401 }),
  );
  render(<NoAccess error="not_listed" />);
  fireEvent.click(screen.getByRole("button", { name: "Use another account" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Use another account" }));
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith("/auth/start?return=%2Finstalls"),
  );
  const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(url).toBe("/auth/logout");
  expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("tok");
});

it("the route shows the full all-digit account id from the URL, never a rounded number", async () => {
  const { searchCodec } = await import("../src/router");
  const search = searchCodec.parseSearch(
    "?error=unknown_sub&sub=112233445566778899001",
  );
  expect(search.sub).toBe("112233445566778899001");
  expect(searchCodec.stringifySearch(search)).toBe(
    "?error=unknown_sub&sub=112233445566778899001",
  );
});
