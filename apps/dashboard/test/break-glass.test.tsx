// Directory break-glass (Backend #597/#599): GET R.me answers 401
// break_glass_required { fresh } for the org owner locked out by a
// customer_mismatch. That 401 doesn't sign out: a centered card asks for a
// fresh Google sign-in (stale) or opens a minimal directory screen (fresh)
// that calls only R.directory, R.directoryConfirm and R.directoryCancel.
import { AUTH, R } from "@oa/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiClientError } from "../src/api/client";
import { qk } from "../src/api/queries";
import { reportApiError } from "../src/api/queryClient";
import { BREAK_GLASS_COPY as C, reauthHref } from "../src/auth/BreakGlass";
import { parseHostedParam } from "../src/hostedParam";
import {
  type Call,
  calls,
  installHarness,
  lastClient,
  lastRedirect,
  mount,
  mountHosted,
  server,
} from "./harness";

installHarness();

const MISMATCH = {
  unhealthy: true,
  unhealthyState: "customer_mismatch",
} as const;
const stale = { breakGlass: "stale", ...MISMATCH } as const;
const fresh = { breakGlass: "fresh", ...MISMATCH } as const;

const BASE = {
  mode: "google",
  healthy: false,
  unhealthySince: "2026-10-25T10:00:00.000Z",
  lastError: null,
  nextRunAt: null,
  alertedAt: null,
  customerMismatch: { expected: "C01abc", actual: "C09xyz" },
  held: [],
  lastSuccessAt: "2026-10-25T09:00:00.000Z",
  staleAt: null,
  binding: {
    provider: "google",
    customerId: "C01abc",
    domain: "example.com",
    connectedBy: "ada@example.com",
    connectedAt: "2026-10-01T15:30:00.000Z",
  },
  pendingCount: null,
  pendingCountCapped: false,
  pendingExpiresAt: null,
};
const PENDING = {
  ...BASE,
  state: "pending_confirm",
  customerMismatch: null,
  pendingCount: 12,
  pendingExpiresAt: "2026-10-26T15:30:00.000Z",
};
const OK = { ...BASE, state: "ok", healthy: true, customerMismatch: null };
const OFF = {
  ...BASE,
  mode: "off",
  state: "never",
  binding: null,
  customerMismatch: null,
};

// Every request from here on (the hosted mocks answer ahead of `seen`).
let log: Call[] = [];
beforeEach(() => {
  log = calls();
});
/** Every /api/v1 path requested, deduplicated, in order. */
const paths = () => [
  ...new Set(log.map((c) => c.path).filter((p) => p.startsWith("/api/v1/"))),
];
const meCalls = () => log.filter((c) => c.path === R.me).length;
/** The card is up; the calls are counted from here (the shell's first render,
    before /me answers, asks for its page as it always has). */
const card = async () => {
  await screen.findByRole("heading", { level: 1, name: C.title });
  log.length = 0;
};
const openDirectory = async () => {
  await card();
  fireEvent.click(screen.getByRole("button", { name: C.open }));
};

describe("GET /me 401", () => {
  it("a plain 401 still signs out to the sign-in page", async () => {
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "Sign in" } },
          { status: 401 },
        ),
      ),
    );
    mount("/settings/members");
    await waitFor(() =>
      expect(lastRedirect).toHaveBeenCalledWith(
        `${AUTH.login}?next=%2Fsettings%2Fmembers`,
      ),
    );
    expect(screen.queryByText(C.title)).toBeNull();
  });

  it("break_glass_required doesn't sign out: the card shows, no app shell", async () => {
    mountHosted("/settings/members", stale);
    await card();
    expect(lastRedirect).not.toHaveBeenCalled();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
  });

  // Everything but /me answers the locked-out owner a plain 401, and the
  // shell's first render asks for the library before /me answers.
  it("a plain 401 elsewhere before /me answers doesn't sign out", async () => {
    mountHosted("/", stale, undefined, [
      http.get("*/api/v1/me", async () => {
        await new Promise((r) => setTimeout(r, 150));
        return HttpResponse.json(
          {
            error: {
              code: "break_glass_required",
              message: "x",
              details: { fresh: false },
            },
          },
          { status: 401 },
        );
      }),
      http.get("*/api/v1/artifacts", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "Sign in" } },
          { status: 401 },
        ),
      ),
    ]);
    await card();
    expect(lastRedirect).not.toHaveBeenCalled();
  });

  it("a plain 401 elsewhere after the card shows doesn't sign out", async () => {
    mountHosted("/", stale);
    await card();
    reportApiError(
      lastClient,
      new ApiClientError("unauthorized", "Sign in", 401),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(
      screen.getByRole("heading", { level: 1, name: C.title }),
    ).toBeVisible();
    expect(lastRedirect).not.toHaveBeenCalled();
  });

  it("the generic 401 path leaves /me alone for break_glass_required", async () => {
    const me = lastClient
      .getQueryCache()
      .build(lastClient, { queryKey: qk.me });
    reportApiError(
      lastClient,
      new ApiClientError("break_glass_required", "x", 401, { fresh: true }),
    );
    await lastClient.cancelQueries({ queryKey: qk.me });
    await new Promise((r) => setTimeout(r, 0));
    expect(me.state.status).not.toBe("error");
  });
});

describe("stale (fresh: false)", () => {
  it("asks for a fresh Google sign-in, back to this page", async () => {
    mountHosted("/settings/members?tab=x", stale);
    await card();
    expect(screen.getByText(C.body("Open Artifacts"))).toBeVisible();
    // The instance's brand row sits above the card, as on sign-in.
    const brand = screen.getByTestId("break-glass-brand");
    expect(brand).toHaveTextContent("Open Artifacts");
    expect(brand.closest(".oa-panel")).toBeNull();
    expect(screen.getByRole("link", { name: C.reauth })).toHaveAttribute(
      "href",
      `${AUTH.loginGoogle}?reauth=1&next=${encodeURIComponent("/settings/members?tab=x")}`,
    );
    expect(screen.getByText(C.reauthNote)).toBeVisible();
    expect(screen.getByText(C.audit)).toBeVisible();
    expect(screen.getByRole("button", { name: C.signOut })).toBeVisible();
    expect(screen.queryByRole("button", { name: C.open })).toBeNull();
    expect(paths()).toEqual([]);
  });

  it("next goes through safeNext", () => {
    expect(reauthHref("//evil.example/x")).toBe(
      `${AUTH.loginGoogle}?reauth=1&next=%2F`,
    );
    expect(reauthHref("/a b")).toBe(`${AUTH.loginGoogle}?reauth=1&next=%2F`);
    expect(reauthHref("/settings")).toBe(
      `${AUTH.loginGoogle}?reauth=1&next=%2Fsettings`,
    );
  });

  it("Sign out posts logout, then goes to /sign-in", async () => {
    let out = false;
    mountHosted("/", stale, undefined, [
      http.post(`*${AUTH.logout}`, () => {
        out = true;
        return new HttpResponse(null, { status: 204 });
      }),
    ]);
    await card();
    fireEvent.click(screen.getByRole("button", { name: C.signOut }));
    await waitFor(() => expect(lastRedirect).toHaveBeenCalledWith("/sign-in"));
    expect(out).toBe(true);
  });
});

describe("fresh (fresh: true)", () => {
  it("offers the directory settings, not a sign-in", async () => {
    mountHosted("/", fresh);
    await card();
    expect(screen.getByRole("button", { name: C.open })).toBeVisible();
    expect(screen.queryByRole("link", { name: C.reauth })).toBeNull();
    expect(screen.getByText(C.audit)).toBeVisible();
    expect(screen.getByRole("button", { name: C.signOut })).toBeVisible();
    expect(paths()).toEqual([]);
  });

  it("the minimal screen: reconnect, the audit note, only R.directory", async () => {
    mountHosted("/", fresh);
    await openDirectory();
    expect(
      await screen.findByRole("link", { name: C.reconnect }),
    ).toHaveAttribute("href", R.directoryConnect);
    expect(
      screen.getByRole("heading", { level: 1, name: C.reconnectTitle }),
    ).toBeVisible();
    expect(screen.getByText(C.audit)).toBeVisible();
    expect(screen.getByRole("button", { name: C.signOut })).toBeVisible();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(paths()).toEqual([R.directory]);
    expect(meCalls()).toBe(0);
  });

  it("back from Google on /settings/directory: opens the minimal screen, with the connect error", async () => {
    mountHosted("/settings/directory?error=customer_mismatch", fresh);
    expect(await screen.findByText(C.connectFailed)).toBeVisible();
    expect(
      screen.getByRole("heading", { level: 1, name: C.reconnectTitle }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "That Google Workspace belongs to a different organization. Reconnect the one you connected before.",
      ),
    ).toBeVisible();
    // The failure is the alert; the reason under it is plain text.
    expect(screen.getByRole("alert")).toHaveTextContent(C.connectFailed);
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      /different organization/,
    );
    expect(meCalls()).toBe(1);
  });

  it("pending: Confirm posts R.directoryConfirm, then says it's done", async () => {
    let body: object = PENDING;
    mountHosted("/", fresh, undefined, [
      http.get("*/api/v1/directory", () => HttpResponse.json(body)),
      http.post("*/api/v1/directory/confirm", () => {
        body = OK;
        return HttpResponse.json(OK);
      }),
    ]);
    await openDirectory();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Add 12 people?" }),
    ).toBeVisible();
    expect(screen.getByText(C.audit)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add 12 people" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: C.doneTitle }),
    ).toBeVisible();
    expect(screen.getByText(C.audit)).toBeVisible();
    expect(paths()).toEqual([R.directory, R.directoryConfirm]);
    expect(meCalls()).toBe(0);
  });

  it("pending: Cancel posts R.directoryCancel and offers to reconnect", async () => {
    let body: object = PENDING;
    mountHosted("/", fresh, undefined, [
      http.get("*/api/v1/directory", () => HttpResponse.json(body)),
      http.post("*/api/v1/directory/cancel", () => {
        body = OFF;
        return new HttpResponse(null, { status: 204 });
      }),
    ]);
    await openDirectory();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(C.cancelled)).toBeVisible();
    expect(screen.getByRole("link", { name: C.reconnect })).toHaveAttribute(
      "href",
      R.directoryConnect,
    );
    expect(screen.getByText(C.audit)).toBeVisible();
    expect(paths()).toEqual([R.directory, R.directoryCancel]);
  });

  it("Continue after reconnecting asks /me again", async () => {
    mountHosted("/", fresh, undefined, [
      http.get("*/api/v1/directory", () => HttpResponse.json(PENDING)),
      http.post("*/api/v1/directory/confirm", () => HttpResponse.json(OK)),
    ]);
    await openDirectory();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add 12 people" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: C.continue("Open Artifacts") }),
    );
    await waitFor(() => expect(meCalls()).toBe(1));
  });

  it("the session was revoked (a plain 401 from the directory): to sign-in", async () => {
    mountHosted("/settings/directory", fresh, undefined, [
      http.get("*/api/v1/directory", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "Sign in" } },
          { status: 401 },
        ),
      ),
    ]);
    await waitFor(() =>
      expect(lastRedirect).toHaveBeenCalledWith(
        `${AUTH.login}?next=%2Fsettings%2Fdirectory`,
      ),
    );
    expect(screen.queryByText(C.loadFailed)).toBeNull();
  });

  it("revoked mid-confirm (a plain 401 from R.directoryConfirm): to sign-in", async () => {
    mountHosted("/", fresh, undefined, [
      http.get("*/api/v1/directory", () => HttpResponse.json(PENDING)),
      http.post("*/api/v1/directory/confirm", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "Sign in" } },
          { status: 401 },
        ),
      ),
    ]);
    await openDirectory();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add 12 people" }),
    );
    await waitFor(() =>
      expect(lastRedirect).toHaveBeenCalledWith(`${AUTH.login}?next=%2F`),
    );
  });

  it("the fresh window lapsed (reauth_required): back to the sign-in step", async () => {
    mountHosted("/", fresh, undefined, [
      http.get("*/api/v1/directory", () =>
        HttpResponse.json(
          { error: { code: "reauth_required", message: "Sign in again" } },
          { status: 401 },
        ),
      ),
    ]);
    await openDirectory();
    expect(await screen.findByRole("link", { name: C.reauth })).toBeVisible();
    expect(screen.getByText(C.reauthNote)).toBeVisible();
    expect(lastRedirect).not.toHaveBeenCalled();
  });
});

it("?hosted= tokens: break-glass (fresh) and break-glass-stale", () => {
  expect(parseHostedParam("break-glass")).toEqual(fresh);
  expect(parseHostedParam("break-glass-stale")).toEqual(stale);
});
