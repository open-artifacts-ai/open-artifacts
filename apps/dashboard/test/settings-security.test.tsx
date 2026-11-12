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
  response: {
    clientDataJSON: "AAAA",
    authenticatorData: "AAAA",
    signature: "AAAA",
  },
};
const CREDENTIAL = {
  id: "new",
  rawId: "new",
  type: "public-key",
  response: { clientDataJSON: "AAAA", attestationObject: "AAAA" },
};
const fake = (json: object) => ({ toJSON: () => json });

beforeEach(() => {
  get.mockReset().mockResolvedValue(fake(ASSERTION));
  create.mockReset().mockResolvedValue(fake(CREDENTIAL));
  Object.defineProperty(navigator, "credentials", {
    value: { get, create },
    configurable: true,
  });
});
afterEach(() => vi.restoreAllMocks());

const use = (state: "none" | "cooling" | "usable" | "pending") =>
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
    http.patch(`*${R.passkeySettings}`, async ({ request }) => {
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
    const line = await screen.findByText("Waiting for your passkey…");
    expect(line).toBeVisible();
    // Directly under the switch that caused it.
    expect(line.parentElement).toContainElement(await sw("Share"));
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
        err("passkey_cooling", 409, { usableAt: until }),
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
    expect(row).toHaveTextContent(
      /Can approve from .+\. New passkeys wait 24 hours, in case someone else added one\./,
    );
  });

  it("the remove dialog warns only when it is the only passkey", async () => {
    use("cooling");
    mount("/settings/security");
    await screen.findByText("This laptop");
    fireEvent.click(screen.getByRole("button", { name: "Remove This laptop" }));
    const d = await screen.findByRole("alertdialog");
    expect(d).toHaveTextContent(
      "It's your only passkey. Without one, approve risky actions in your agent's terminal.",
    );
    // No usable passkey: the re-auth path, so the 24 hour delay is said too.
    expect(d).toHaveTextContent(
      "It's removed after 24 hours, so you can cancel if this wasn't you.",
    );
    // The delayed path drops the immediate-removal line, and is not red.
    expect(d).not.toHaveTextContent("You won't be able to approve picks");
    expect(within(d).getByRole("button", { name: "Remove" }).className).toMatch(
      /bg-primary/,
    );
  });

  it("the remove dialog says nothing of it with two passkeys", async () => {
    use("usable");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Remove MacBook" }));
    const d = await screen.findByRole("alertdialog");
    expect(d).not.toHaveTextContent("only passkey");
    // A usable passkey asserts: the removal is immediate, no delay line.
    expect(d).not.toHaveTextContent("removed after 24 hours");
    expect(d).toHaveTextContent("You won't be able to approve picks with it.");
    expect(within(d).getByRole("button", { name: "Remove" }).className).toMatch(
      /bg-destructive/,
    );
  });

  it("a failed remove shows its line under that passkey", async () => {
    use("usable");
    get.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    mount("/settings/security");
    await screen.findByText("Phone");
    fireEvent.click(screen.getByRole("button", { name: "Remove Phone" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    const line = await screen.findByText("Nothing was removed.");
    expect(line.closest("li")).toHaveTextContent("Phone");
    expect(screen.getByText("MacBook").closest("li")).not.toContainElement(
      line,
    );
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
      { credential: CREDENTIAL },
    );
    // The first passkey needs no approval.
    expect(posts.some((c) => c.path === R.passkeyRegisterChallenge)).toBe(
      false,
    );
    expect(get).not.toHaveBeenCalled();
    expect(
      posts.find((c) => c.path === R.passkeyRegisterBegin)?.body,
    ).toBeUndefined();
  });

  it("with a working passkey, an existing one approves: challenge, prompt, begin with the assertion, create, finish", async () => {
    use("usable");
    const posts = calls("POST");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Passkey")).toBeVisible();
    const paths = posts.map((c) => c.path);
    expect(paths.indexOf(R.passkeyRegisterChallenge)).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf(R.passkeyRegisterChallenge)).toBeLessThan(
      paths.indexOf(R.passkeyRegisterBegin),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(posts.find((c) => c.path === R.passkeyRegisterBegin)?.body).toEqual({
      assertion: ASSERTION,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a cancelled approval adds nothing: no begin, no create", async () => {
    use("usable");
    get.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    const posts = calls("POST");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Nothing was added.")).toBeVisible();
    expect(posts.some((c) => c.path === R.passkeyRegisterBegin)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("a stale list: a 409 from the challenge falls back to begin without an assertion", async () => {
    use("usable");
    server.use(
      http.post(`*${R.passkeyRegisterChallenge}`, () => err("conflict", 409)),
      // The server now agrees nothing needs to approve.
      http.post(`*${R.passkeyRegisterBegin}`, () =>
        HttpResponse.json({
          options: {
            challenge: "AAAA",
            rp: { name: "OA" },
            user: { id: "AAAA", name: "a", displayName: "A" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
          expiresAt: new Date().toISOString(),
        }),
      ),
    );
    const posts = calls("POST");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(get).not.toHaveBeenCalled();
    expect(
      posts.find((c) => c.path === R.passkeyRegisterBegin)?.body,
    ).toBeUndefined();
  });

  it("re-auth from the challenge leaves before any passkey prompt, and marks the return", async () => {
    use("usable");
    const redirect = vi
      .spyOn(webauthn, "redirectTo")
      .mockImplementation(() => {});
    server.use(
      http.post(`*${R.passkeyRegisterChallenge}`, () =>
        err("reauth_required", 401, { reauthUrl: "/sign-in?reauth=1" }),
      ),
    );
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    expect(get).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("oa.passkey.addAfterReauth")).not.toBeNull();
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
    expect(sessionStorage.getItem("oa.passkey.addAfterReauth")).toBeNull();
  });
});

describe("Settings › Security: stale state, return from sign-in, pending removal", () => {
  afterEach(() => sessionStorage.clear());

  it("builds a switch change from the server's state, not the cached one", async () => {
    const s = settingsServer(base);
    mount("/settings/security");
    const merge = await live("Merge");
    // Another tab turned Share off... and back: the server now differs from the cache.
    server.use(
      http.get(`*${R.passkeySettings}`, () =>
        HttpResponse.json({
          ...base,
          actions: { ...base.actions, share: false },
        }),
      ),
    );
    fireEvent.click(merge);
    await waitFor(() => expect(s.puts.length).toBe(1));
    expect(s.challenges).toEqual([
      {
        actions: { ...base.actions, share: false, merge: false },
        everyPick: false,
      },
    ]);
  });

  it("says the device already has a passkey (InvalidStateError)", async () => {
    use("none");
    create.mockRejectedValue(new DOMException("dup", "InvalidStateError"));
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(
      await screen.findByText(
        "This device already has a passkey for this account. Nothing was added.",
      ),
    ).toBeVisible();
  });

  it("always says Add asks you to sign in again", async () => {
    use("none");
    mount("/settings/security");
    expect(
      await screen.findByText(
        "Adding a passkey asks you to sign in again first.",
      ),
    ).toBeVisible();
  });

  it("marks the return before following the sign-in, only when it follows", async () => {
    use("none");
    const redirect = vi.spyOn(webauthn, "redirectTo").mockImplementation(() => {
      // The mark is the time we left.
      const at = Number(sessionStorage.getItem("oa.passkey.addAfterReauth"));
      expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
    });
    server.use(
      http.post(`*${R.passkeyRegisterBegin}`, () =>
        err("reauth_required", 401, {
          reauthUrl: "/sign-in?next=/settings/security",
        }),
      ),
    );
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
  });

  it("back from the sign-in: clears the mark, focuses Add, says so, does not call create", async () => {
    use("none");
    sessionStorage.setItem("oa.passkey.addAfterReauth", String(Date.now()));
    mount("/settings/security");
    const add = await screen.findByRole("button", { name: "Add a passkey" });
    expect(
      await screen.findByText(
        "You're signed in again. Add your passkey within 10 minutes.",
      ),
    ).toBeVisible();
    expect(add).toHaveFocus();
    expect(sessionStorage.getItem("oa.passkey.addAfterReauth")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    // The green line replaces the "sign in again first" note.
    expect(screen.queryByText(/asks you to sign in again first/)).toBeNull();
  });

  it("a mark older than 10 minutes is cleared and ignored", async () => {
    use("none");
    sessionStorage.setItem(
      "oa.passkey.addAfterReauth",
      String(Date.now() - 11 * 60_000),
    );
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    expect(screen.queryByText(/signed in again\./)).toBeNull();
    expect(sessionStorage.getItem("oa.passkey.addAfterReauth")).toBeNull();
    expect(
      screen.getByText("Adding a passkey asks you to sign in again first."),
    ).toBeVisible();
  });

  it("Cancel removal ignores a second click while it works", async () => {
    use("pending");
    let n = 0;
    server.use(
      http.post("*/api/v1/passkeys/:id/cancel-removal", async () => {
        n += 1;
        await new Promise((r) => setTimeout(r, 50));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    mount("/settings/security");
    const b = await screen.findByRole("button", {
      name: "Cancel removal of Phone",
    });
    fireEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(b);
    await waitFor(() => expect(b).not.toHaveAttribute("aria-disabled"));
    expect(n).toBe(1);
  });

  it("without the mark, no return line", async () => {
    use("none");
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    expect(screen.queryByText(/signed in again/)).toBeNull();
  });

  it("Add keeps focus while adding", async () => {
    use("none");
    create.mockReturnValue(new Promise(() => {}));
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    const add = screen.getByRole("button", { name: "Add a passkey" });
    add.focus();
    fireEvent.click(add);
    const busy = await screen.findByRole("button", { name: "Adding…" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveFocus();
    fireEvent.click(busy);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("shows a pending removal with Cancel; cancel puts Remove back", async () => {
    use("pending");
    const posts = calls("POST");
    mount("/settings/security");
    const row = (await screen.findByText("Phone")).closest("li");
    expect(row).toHaveTextContent(/Will be removed /);
    expect(
      within(row as HTMLElement).queryByRole("button", { name: /^Remove / }),
    ).toBeNull();
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", {
        name: "Cancel removal of Phone",
      }),
    );
    await screen.findByRole("button", { name: "Remove Phone" });
    expect(posts.some((c) => c.path === R.passkeyCancelRemoval("pk_b"))).toBe(
      true,
    );
  });

  it("a re-auth-only removal is scheduled (202): toast and Removes line", async () => {
    use("cooling");
    mount("/settings/security");
    await screen.findByText("This laptop");
    fireEvent.click(screen.getByRole("button", { name: "Remove This laptop" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    expect(
      await screen.findByText(
        "This passkey will be removed in 24 hours. You can cancel until then.",
      ),
    ).toBeVisible();
    expect(
      (await screen.findByText("This laptop")).closest("li"),
    ).toHaveTextContent(/Will be removed /);
    expect(get).not.toHaveBeenCalled();
  });

  it("after a removal, focus goes to the Passkeys heading", async () => {
    use("usable");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Remove MacBook" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() => expect(screen.queryByText("MacBook")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Passkeys" })).toHaveFocus(),
    );
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
