import { AUTH, QUOTA_MESSAGE, type Role } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "../src/api/queries";
import { makeQueryClient, QUOTA_KEY } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { createAppRouter } from "../src/router";
import { installClock, settle } from "./clock";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const unauth = () =>
  json({ error: { code: "unauthorized", message: "no" } }, 401);
const meAs = (role: Role) => {
  const me = structuredClone(fixtures.me);
  me.user.role = role;
  return json(me);
};

const mount = (
  fetchImpl: (u: string, i?: RequestInit) => Promise<Response>,
  path: string,
) => {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const redirect = vi.fn();
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={client}>
      <RedirectProvider value={redirect}>
        <RouterProvider router={router} />
      </RedirectProvider>
    </QueryClientProvider>,
  );
  return { redirect, client };
};

afterEach(() => vi.unstubAllGlobals());
const signOut = async () => {
  const t = await screen.findByRole("button", { name: "Account menu" });
  fireEvent.keyDown(t, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
};

installClock();

describe("layout behaviour", () => {
  // Backend: callback for a non-member responds 302 /no-access WITHOUT a session,
  // so /me is 401 there. Redirecting to login sends them straight back: infinite loop.
  it("anonymous at /no-access is not bounced to login (loop)", async () => {
    const { redirect } = mount(async () => unauth(), "/no-access");
    await settle(100);
    expect(redirect).not.toHaveBeenCalled();
  });

  // #3029: a path with no route goes to the sign-in page flagged dead, no next;
  // a known one keeps the server's /auth/login?next= hop.
  it("anonymous at an unknown path goes to /sign-in?dead=1", async () => {
    const { redirect } = mount(async () => unauth(), "/invite/x");
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith("/sign-in?dead=1"),
    );
  });
  it("anonymous at a known path keeps next through /auth/login", async () => {
    const { redirect } = mount(async () => unauth(), "/mine");
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith("/auth/login?next=%2Fmine"),
    );
  });

  // TanStack Router matches case-insensitively, so /A/x renders the viewer, yet
  // the anonymous exemption is a case-sensitive startsWith("/a/").
  it("anonymous at /A/x (renders the viewer route) is not redirected", async () => {
    const { redirect } = mount(async () => unauth(), "/A/x");
    // Wait for the viewer's redirect, then a beat for any extra one.
    await waitFor(() => expect(redirect).toHaveBeenCalled());
    await settle(100);
    // Only the viewer's own login redirect (to the lowercase path); the layout adds none.
    expect(redirect.mock.calls).toEqual([["/auth/login?next=%2Fa%2Fx"]]);
  });

  // Session expires while the app is open: /me refetch 401s but stale data wins.
  it("a 401 on /me refetch after being authed becomes anonymous", async () => {
    let authed = true;
    const { redirect, client } = mount(
      async () => (authed ? meAs("member") : unauth()),
      "/",
    );
    await screen.findAllByRole("link", { name: "Team" });
    authed = false;
    await act(() => client.invalidateQueries({ queryKey: qk.me }));
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(`${AUTH.login}?next=%2F`),
    );
  });

  // /me 500 / network failure: state stays "loading" forever and the shell shows
  // member nav (Library) to a visitor whose identity is unknown, with no error UI.
  it("/me 500 does not leave the shell rendered with Library nav", async () => {
    mount(
      async () => json({ error: { code: "internal", message: "x" } }, 500),
      "/",
    );
    await settle(100);
    await settle(100);
    expect(screen.queryByRole("link", { name: "Library" })).toBeNull();
  });

  // Log out redirects to AUTH.login, which (with a live Access session) signs
  // the user straight back in. It also redirects even when logout fails.
  it("log out does not land on the auto-login endpoint", async () => {
    const { redirect } = mount(
      async (u) =>
        String(u).includes(AUTH.logout)
          ? new Response(null, { status: 204 })
          : meAs("member"),
      "/",
    );
    await signOut();
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/sign-in"));
  });

  // Axe M1: signing out turns this browser's notifications off first.
  const pushThenLogout = (path: string) => {
    localStorage.setItem(
      "oa.push.subscription.v2",
      JSON.stringify({ userId: "u1", id: "sub_1" }),
    );
    const order: string[] = [];
    const m = mount(async (u, i) => {
      const url = String(u);
      if (url.includes("/api/v1/me/push/subscriptions/sub_1")) {
        order.push(`${i?.method} push`);
        return new Response(null, { status: 204 });
      }
      if (url.includes(AUTH.logout)) {
        order.push(`${i?.method} logout`);
        return new Response(null, { status: 204 });
      }
      return meAs("member");
    }, path);
    return { ...m, order };
  };
  afterEach(() => localStorage.clear());

  it("Log out (account menu) deletes this browser's push subscription before the session ends", async () => {
    const { redirect, order } = pushThenLogout("/");
    await signOut();
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/sign-in"));
    expect(order).toEqual(["DELETE push", "POST logout"]);
    expect(localStorage.getItem("oa.push.subscription.v2")).toBeNull();
  });

  it("Log out (No access page) deletes this browser's push subscription before the session ends", async () => {
    const { redirect, order } = pushThenLogout("/no-access");
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/sign-in"));
    expect(order).toEqual(["DELETE push", "POST logout"]);
  });

  it("a failing push delete never stops the sign-out", async () => {
    localStorage.setItem(
      "oa.push.subscription.v2",
      JSON.stringify({ userId: "u1", id: "sub_1" }),
    );
    const { redirect } = mount(
      async (u) =>
        String(u).includes("/api/v1/me/push/subscriptions/")
          ? json({ error: { code: "internal", message: "x" } }, 500)
          : String(u).includes(AUTH.logout)
            ? new Response(null, { status: 204 })
            : meAs("member"),
      "/",
    );
    await signOut();
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/sign-in"));
  });

  it("failed logout (500) does not pretend the user is logged out", async () => {
    const { redirect } = mount(
      async (u) =>
        String(u).includes(AUTH.logout)
          ? json({ error: { code: "internal", message: "x" } }, 500)
          : meAs("member"),
      "/",
    );
    await signOut();
    expect(await screen.findByText("Couldn't log out")).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("anonymous at /sign-in is not redirected and sees the login page", async () => {
    const { redirect } = mount(async () => unauth(), "/sign-in");
    await screen.findByRole("heading", { name: /Log in/ });
    await settle(100);
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("NoAccess renders for a logged-in non-member with a log-out button", async () => {
    mount(async () => meAs("guest"), "/no-access");
    expect(
      await screen.findByRole("heading", { name: /nothing here for you yet/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("NoAccess log out goes to /sign-in", async () => {
    const { redirect } = mount(
      async (u) =>
        String(u).includes(AUTH.logout)
          ? new Response(null, { status: 204 })
          : meAs("member"),
      "/no-access",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/sign-in"));
  });

  it("only owner/admin see Usage", async () => {
    for (const [role, usage] of [
      ["admin", true],
      ["member", false],
      ["guest", false],
    ] as const) {
      mount(async () => meAs(role), "/shared");
      // #2590: a guest's sidebar link reads "Shared with you".
      await screen.findAllByRole("link", {
        name: role === "guest" ? "Shared with you" : "Shared with me",
      });
      expect(!!screen.queryByRole("link", { name: "Usage" })).toBe(usage);
      cleanup();
    }
  });

  it("guest at / is sent to /shared", async () => {
    mount(async () => meAs("guest"), "/");
    // #2590: the guest home is "Shared with you" (no tab strip).
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Shared with you" }),
      ).toBeInTheDocument(),
    );
  });

  it("/me 500 shows an error panel with Retry that refetches", async () => {
    let fail = true;
    mount(
      async () =>
        fail
          ? json({ error: { code: "internal", message: "x" } }, 500)
          : meAs("member"),
      "/",
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    fireEvent.click(retry);
    await screen.findAllByRole("link", { name: "Team" });
  });

  it("quota banner clears after a later successful query", async () => {
    const { client } = mount(async () => meAs("member"), "/");
    await screen.findAllByRole("link", { name: "Team" });
    await act(async () => {
      client.setQueryData(QUOTA_KEY, true);
    });
    await screen.findByText(QUOTA_MESSAGE);
    await act(() => client.invalidateQueries({ queryKey: qk.me }));
    await waitFor(() => expect(screen.queryByText(QUOTA_MESSAGE)).toBeNull());
  });

  it("a 500 on /me refetch keeps the authed shell (no error panel)", async () => {
    let fail = false;
    const { client } = mount(
      async () =>
        fail
          ? json({ error: { code: "internal", message: "x" } }, 500)
          : meAs("member"),
      "/",
    );
    await screen.findAllByRole("link", { name: "Team" });
    fail = true;
    await act(() => client.invalidateQueries({ queryKey: qk.me }));
    expect(client.getQueryState(qk.me)?.status).toBe("error");
    expect(screen.queryByText("Couldn't load your account")).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Team" }).length,
    ).toBeGreaterThan(0);
  });
});
