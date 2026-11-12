// #2263: Settings › Security, passkeys and the "ask for a passkey" switches.

import type { PasskeySettings } from "@oa/shared";
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as webauthn from "../src/auth/webauthn";
import { calls, installHarness, mount, server } from "./harness";

installHarness();

const get = vi.fn();
const create = vi.fn();
const ASSERTION = {
  id: "cred",
  rawId: "cred",
  type: "public-key",
  response: {},
};
const fake = (json: object) => ({ toJSON: () => json });

beforeEach(() => {
  get.mockReset().mockResolvedValue(fake(ASSERTION));
  create.mockReset().mockResolvedValue(fake({ ...ASSERTION, id: "new" }));
  Object.defineProperty(navigator, "credentials", {
    value: { get, create },
    configurable: true,
  });
});
afterEach(() => vi.restoreAllMocks());

const use = (state: "none" | "cooling" | "usable") =>
  server.use(...createHandlers({ passkeys: state }));

const err = (code: string, status: number, details?: unknown) =>
  HttpResponse.json({ error: { code, message: code, details } }, { status });

const base: PasskeySettings = {
  actions: {
    merge: true,
    deploy: true,
    delete: true,
    share: true,
    public: true,
    command: true,
  },
  everyPick: false,
  locked: ["command"],
  hasPasskey: true,
  hasUsablePasskey: true,
};

/** A settings server of our own, to see exactly what the page sends. */
function settingsServer(initial: PasskeySettings, put?: () => Response) {
  let s = initial;
  const puts: unknown[] = [];
  const challenges: unknown[] = [];
  server.use(
    http.get(`*${R.passkeySettings}`, () => HttpResponse.json(s)),
    http.post(`*${R.passkeySettingsChallenge}`, async ({ request }) => {
      challenges.push(await request.json());
      return HttpResponse.json({
        options: {
          challenge: "AAAA",
          allowCredentials: [{ id: "AAAA", type: "public-key" }],
        },
        expiresAt: new Date().toISOString(),
      });
    }),
    http.put(`*${R.passkeySettings}`, async ({ request }) => {
      const b = (await request.json()) as {
        actions: PasskeySettings["actions"];
        everyPick: boolean;
      };
      puts.push(b);
      const bad = put?.();
      if (bad) return bad;
      s = { ...s, actions: b.actions, everyPick: b.everyPick };
      return HttpResponse.json(s);
    }),
  );
  return { puts, challenges };
}

const sw = (name: string) => screen.findByRole("switch", { name });
/** A switch once the settings have loaded (it is disabled until then). */
const live = async (name: string) => {
  const s = await sw(name);
  await waitFor(() => expect(s).toBeEnabled());
  return s;
};

describe("Settings › Security: passkey switches", () => {
  it("is a Settings tab", async () => {
    use("usable");
    mount("/settings/security");
    expect(
      await screen.findByRole("link", { name: "Security" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("with no passkey, shows the switches disabled and says to add one", async () => {
    use("none");
    mount("/settings/security");
    const merge = await sw("Merge");
    await screen.findByText("Add a passkey to use these.");
    for (const n of [
      "Merge",
      "Deploy",
      "Delete",
      "Share",
      "Make public",
      "Every pick",
    ])
      expect(await sw(n)).toBeDisabled();
    expect(merge).toHaveAccessibleDescription("Add a passkey to use these.");
    expect(screen.getByText("No passkeys yet.")).toBeInTheDocument();
  });

  it("locks 'Run a command' on", async () => {
    use("usable");
    mount("/settings/security");
    const cmd = await sw("Run a command");
    expect(cmd).toBeDisabled();
    expect(cmd).toHaveAttribute("aria-checked", "true");
    expect(cmd).toHaveAccessibleDescription(
      "Always on: this runs code on your computer.",
    );
  });

  it("turning a switch on PUTs straight away, with no assertion", async () => {
    const { puts, challenges } = settingsServer({
      ...base,
      actions: { ...base.actions, merge: false },
    });
    mount("/settings/security");
    const merge = await live("Merge");
    expect(merge).toHaveAttribute("aria-checked", "false");
    fireEvent.click(merge);
    await waitFor(() => expect(merge).toHaveAttribute("aria-checked", "true"));
    expect(puts).toEqual([{ actions: base.actions, everyPick: false }]);
    expect(challenges).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("turning one off asks the server for a challenge, gets a passkey, then PUTs with the assertion", async () => {
    const { puts, challenges } = settingsServer(base);
    mount("/settings/security");
    const deploy = await live("Deploy");
    fireEvent.click(deploy);
    // Not optimistic: still on until the server says so.
    expect(deploy).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(deploy).toHaveAttribute("aria-checked", "false"),
    );
    const body = {
      actions: { ...base.actions, deploy: false },
      everyPick: false,
    };
    expect(challenges).toEqual([body]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([{ ...body, assertion: ASSERTION }]);
    expect(deploy).toHaveFocus();
  });

  it("shows 'Waiting for your passkey…' while the prompt is open", async () => {
    settingsServer(base);
    get.mockReturnValue(new Promise(() => {}));
    mount("/settings/security");
    fireEvent.click(await live("Share"));
    expect(await screen.findByText("Waiting for your passkey…")).toBeVisible();
    expect(await sw("Share")).toHaveAttribute("aria-checked", "true");
  });

  it("a cancelled prompt leaves the switch on and says nothing was changed", async () => {
    const { puts } = settingsServer(base);
    get.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    mount("/settings/security");
    const del = await live("Delete");
    fireEvent.click(del);
    expect(await screen.findByText("Nothing was changed.")).toBeVisible();
    expect(del).toHaveAttribute("aria-checked", "true");
    expect(puts).toEqual([]);
    expect(del).toHaveFocus();
  });

  it("a cooling passkey says when it can approve, and nothing changed", async () => {
    settingsServer(base);
    const until = new Date(Date.now() + 5 * 3600_000).toISOString();
    server.use(
      http.post(`*${R.passkeySettingsChallenge}`, () =>
        err("passkey_cooling", 409, { until }),
      ),
    );
    mount("/settings/security");
    const m = await live("Merge");
    fireEvent.click(m);
    const line = await screen.findByText(/Your new passkey can approve from/);
    expect(line).toHaveTextContent(webauthn.coolingTime(until));
    expect(line).toHaveTextContent("Nothing was changed.");
    expect(m).toHaveAttribute("aria-checked", "true");
  });

  it.each([
    ["passkey_failed", 400],
    ["challenge_expired", 410],
    ["passkey_required", 403],
    ["no_passkey", 409],
    ["rate_limited", 429],
  ])("%s ends with 'Nothing was changed.'", async (code, status) => {
    settingsServer(base, () => err(code, status));
    mount("/settings/security");
    fireEvent.click(await live("Merge"));
    expect(await screen.findByText(/Nothing was changed\.$/)).toBeVisible();
    expect(await sw("Merge")).toHaveAttribute("aria-checked", "true");
  });
});

describe("Settings › Security: passkeys", () => {
  it("lists passkeys, with a cooling one's time", async () => {
    use("cooling");
    mount("/settings/security");
    const row = (await screen.findByText("This laptop")).closest("li");
    expect(row).toHaveTextContent("Never used");
    expect(row).toHaveTextContent(/Can approve from /);
  });

  it("removes a passkey: confirm, challenge, passkey, DELETE with the assertion", async () => {
    use("usable");
    const posts = calls("POST");
    const dels = calls("DELETE");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Remove MacBook" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("MacBook")).toBeNull());
    expect(posts.some((c) => c.path === R.passkeyChallenge("pk_a"))).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(dels.find((c) => c.path === R.passkey("pk_a"))?.body).toEqual({
      assertion: ASSERTION,
    });
  });

  it("a cancelled prompt keeps the passkey and says nothing was removed", async () => {
    use("usable");
    get.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    const dels = calls("DELETE");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Remove MacBook" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    expect(await screen.findByText("Nothing was removed.")).toBeVisible();
    expect(screen.getByText("MacBook")).toBeVisible();
    expect(dels).toEqual([]);
  });

  it("with no usable passkey, removing skips the prompt and DELETEs for a fresh sign-in", async () => {
    use("cooling");
    const redirect = vi
      .spyOn(webauthn, "redirectTo")
      .mockImplementation(() => {});
    server.use(
      http.delete("*/api/v1/passkeys/:id", () =>
        err("reauth_required", 401, { reauthUrl: "/sign-in?reauth=1" }),
      ),
    );
    mount("/settings/security");
    await screen.findByText("This laptop");
    fireEvent.click(screen.getByRole("button", { name: "Remove This laptop" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(
        `${location.origin}/sign-in?reauth=1`,
      ),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("adds a passkey: begin, create, finish", async () => {
    use("none");
    const posts = calls("POST");
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Passkey")).toBeVisible();
    expect(create).toHaveBeenCalledTimes(1);
    expect(posts.find((c) => c.path === R.passkeyRegisterFinish)?.body).toEqual(
      { credential: { ...ASSERTION, id: "new" } },
    );
  });

  it("a cancelled add says nothing was added", async () => {
    use("none");
    create.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Nothing was added.")).toBeVisible();
    expect(screen.getByText("No passkeys yet.")).toBeVisible();
  });

  it("follows a same-origin reauthUrl when adding", async () => {
    use("none");
    const redirect = vi
      .spyOn(webauthn, "redirectTo")
      .mockImplementation(() => {});
    server.use(
      http.post(`*${R.passkeyRegisterBegin}`, () =>
        err("reauth_required", 401, { reauthUrl: "/sign-in?reauth=1" }),
      ),
    );
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(
        `${location.origin}/sign-in?reauth=1`,
      ),
    );
  });

  it("never follows a reauthUrl on another origin", async () => {
    use("none");
    const redirect = vi
      .spyOn(webauthn, "redirectTo")
      .mockImplementation(() => {});
    server.use(
      http.post(`*${R.passkeyRegisterBegin}`, () =>
        err("reauth_required", 401, { reauthUrl: "https://evil.example/x" }),
      ),
    );
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText(/Nothing was added\.$/)).toBeVisible();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("sameOriginUrl", () => {
  it("accepts relative and same-origin, refuses the rest", () => {
    const o = location.origin;
    expect(webauthn.sameOriginUrl("/a?b=1")).toBe(`${o}/a?b=1`);
    expect(webauthn.sameOriginUrl(`${o}/x`)).toBe(`${o}/x`);
    for (const u of [
      "https://evil.example/",
      "//evil.example/",
      "javascript:alert(1)",
      "",
      undefined,
      42,
    ])
      expect(webauthn.sameOriginUrl(u)).toBeNull();
  });
});
