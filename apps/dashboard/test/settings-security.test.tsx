// #2263: Settings › Security, passkeys; #2661: a passkey on high-stakes decisions.

import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as webauthn from "../src/auth/webauthn";
import type { PasskeySettings } from "../src/settings/passkeySettings";
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
  highStakes: true,
  everyAnswer: false,
  ownRule: "",
  hasPasskey: true,
};
type Body = Pick<PasskeySettings, "highStakes" | "everyAnswer" | "ownRule">;

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
      const b = (await request.json()) as Body;
      puts.push(b);
      const bad = put?.();
      if (bad) return bad;
      s = {
        ...s,
        highStakes: b.highStakes,
        everyAnswer: b.everyAnswer,
        ownRule: b.ownRule,
      };
      return HttpResponse.json(s);
    }),
  );
  return { puts, challenges };
}

/** The Passkeys card's Add (with no passkey, a second one sits by the switches). */
const addBtn = () =>
  screen.getAllByRole("button", { name: "Add a passkey" })[0] as HTMLElement;
const HIGH = "Ask for my passkey on high-stakes decisions";
const EVERY = "Ask on every answer";
const RULE = "Also treat as high stakes:";
const sw = (name: string) => screen.findByRole("switch", { name });
/** A switch once the settings have loaded (it is disabled until then). */
const live = async (name: string) => {
  const s = await sw(name);
  await waitFor(() => expect(s).toBeEnabled());
  return s;
};
/** The rule field once the settings have loaded. */
const ruleField = async () => {
  const f = await screen.findByLabelText(RULE);
  await waitFor(() => expect(f).toBeEnabled());
  return f as HTMLTextAreaElement;
};

describe("Settings › Security: a passkey on high-stakes decisions (#2661)", () => {
  it("is a Settings tab", async () => {
    use("usable");
    mount("/settings/security");
    expect(
      await screen.findByRole("link", { name: "Security" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows OA Product's words, word for word, and the mock's defaults", async () => {
    use("usable");
    mount("/settings/security");
    expect(
      await screen.findByRole("heading", {
        name: "Passkey for high-stakes decisions",
      }),
    ).toBeVisible();
    const high = await live(HIGH);
    expect(high).toHaveAttribute("aria-checked", "true");
    expect(high).toHaveAccessibleDescription(
      "When an agent or a person marks a decision as high stakes, approving it needs your passkey. Saying no never does.",
    );
    const every = await live(EVERY);
    expect(every).toHaveAttribute("aria-checked", "false");
    expect(every).toHaveAccessibleDescription(
      "Your passkey is needed for every answer you give, high stakes or not.",
    );
    expect(
      screen.getByText(
        "Use a passkey to log in and to approve high-stakes decisions.",
      ),
    ).toBeVisible();
    const rule = await ruleField();
    expect(rule).toHaveAttribute(
      "placeholder",
      "For example: anything that emails a customer",
    );
    expect(rule).toHaveAttribute("maxlength", "500");
    expect(rule).toHaveAccessibleDescription(
      "Your agents are told this. Changing these needs your passkey.",
    );
  });

  it("no developer words: the six per-action switches are gone", async () => {
    use("usable");
    mount("/settings/security");
    await live(HIGH);
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    const text = document.body.textContent ?? "";
    for (const w of [
      /\bmerge\b/i,
      /\bdeploy\b/i,
      /run a command/i,
      /make public/i,
      /every pick/i,
      /\bcode\b/i,
    ])
      expect(text).not.toMatch(w);
  });

  it("with no passkey: both switches off and disabled (never a dimmed on), the field disabled, and Add a passkey right there", async () => {
    use("none");
    mount("/settings/security");
    const line = await screen.findByText("Add a passkey to use these.");
    for (const n of [HIGH, EVERY]) {
      const s = await sw(n);
      expect(s).toBeDisabled();
      expect(s).toHaveAttribute("aria-checked", "false");
      expect(s).toHaveAccessibleDescription(/Add a passkey to use these\.$/);
    }
    expect(await screen.findByLabelText(RULE)).toBeDisabled();
    expect(screen.getByText("No passkeys yet.")).toBeInTheDocument();
    // The button beside the line starts the same add as the Passkeys card's.
    const here = within(line.parentElement as HTMLElement).getByRole("button", {
      name: "Add a passkey",
    });
    fireEvent.click(here);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("a server that still says on, with no passkey, shows off", async () => {
    settingsServer({ ...base, hasPasskey: false, everyAnswer: true });
    mount("/settings/security");
    await screen.findByText("Add a passkey to use these.");
    for (const n of [HIGH, EVERY])
      expect(await sw(n)).toHaveAttribute("aria-checked", "false");
  });

  it.each([
    [HIGH, { ...base, highStakes: false }, { highStakes: true }],
    [EVERY, base, { everyAnswer: true }],
  ])(
    "turning %s on PATCHes straight away, with no passkey",
    async (name, start, change) => {
      const { puts, challenges } = settingsServer(start);
      mount("/settings/security");
      const s = await live(name);
      expect(s).toHaveAttribute("aria-checked", "false");
      fireEvent.click(s);
      await waitFor(() => expect(s).toHaveAttribute("aria-checked", "true"));
      expect(puts).toEqual([
        {
          highStakes: start.highStakes,
          everyAnswer: start.everyAnswer,
          ownRule: "",
          ...change,
        },
      ]);
      expect(challenges).toEqual([]);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each([
    [HIGH, base, { highStakes: false }],
    [EVERY, { ...base, everyAnswer: true }, { everyAnswer: false }],
  ])(
    "turning %s off: a challenge for the same body, the passkey, then PATCH with the assertion",
    async (name, start, change) => {
      const { puts, challenges } = settingsServer(start);
      mount("/settings/security");
      const s = await live(name);
      fireEvent.click(s);
      // Not optimistic: still on until the server says so.
      expect(s).toHaveAttribute("aria-checked", "true");
      await waitFor(() => expect(s).toHaveAttribute("aria-checked", "false"));
      const body = {
        highStakes: start.highStakes,
        everyAnswer: start.everyAnswer,
        ownRule: "",
        ...change,
      };
      expect(challenges).toEqual([body]);
      expect(get).toHaveBeenCalledTimes(1);
      expect(puts).toEqual([{ ...body, assertion: ASSERTION }]);
      expect(s).toHaveFocus();
    },
  );

  it("changing the rule needs the passkey; it is saved trimmed", async () => {
    const { puts, challenges } = settingsServer(base);
    mount("/settings/security");
    const rule = await ruleField();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(rule, {
      target: { value: "  anything that emails a customer " },
    });
    expect(save).not.toHaveAttribute("aria-disabled");
    fireEvent.click(save);
    const body = {
      highStakes: true,
      everyAnswer: false,
      ownRule: "anything that emails a customer",
    };
    await waitFor(() =>
      expect(puts).toEqual([{ ...body, assertion: ASSERTION }]),
    );
    expect(challenges).toEqual([body]);
    await waitFor(() => expect(rule.value).toBe(body.ownRule));
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByText("Saved.")).toBeVisible();
    // Typing again clears it.
    fireEvent.change(rule, { target: { value: "more" } });
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("clearing the rule needs the passkey too", async () => {
    const { puts } = settingsServer({ ...base, ownRule: "anything legal" });
    mount("/settings/security");
    const rule = await ruleField();
    await waitFor(() => expect(rule.value).toBe("anything legal"));
    fireEvent.change(rule, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(puts).toEqual([
        {
          highStakes: true,
          everyAnswer: false,
          ownRule: "",
          assertion: ASSERTION,
        },
      ]),
    );
  });

  it("an unchanged rule (only spaces added) saves nothing", async () => {
    const { puts } = settingsServer({ ...base, ownRule: "x" });
    mount("/settings/security");
    const rule = await ruleField();
    await waitFor(() => expect(rule.value).toBe("x"));
    fireEvent.change(rule, { target: { value: " x " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(puts).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("shows 'Waiting for your passkey…' under the switch while the prompt is open", async () => {
    settingsServer(base);
    get.mockReturnValue(new Promise(() => {}));
    mount("/settings/security");
    fireEvent.click(await live(HIGH));
    const line = await screen.findByText("Waiting for your passkey…");
    expect(line).toBeVisible();
    expect(line.parentElement).toContainElement(await sw(HIGH));
    expect(await sw(HIGH)).toHaveAttribute("aria-checked", "true");
  });

  it("a cancelled prompt leaves the switch on and says nothing was changed", async () => {
    const { puts } = settingsServer(base);
    get.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    mount("/settings/security");
    const high = await live(HIGH);
    fireEvent.click(high);
    expect(await screen.findByText("Nothing was changed.")).toBeVisible();
    expect(high).toHaveAttribute("aria-checked", "true");
    expect(puts).toEqual([]);
    expect(high).toHaveFocus();
  });

  it("a cancelled prompt on the rule keeps what was typed", async () => {
    const { puts } = settingsServer(base);
    get.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    mount("/settings/security");
    const rule = await ruleField();
    fireEvent.change(rule, { target: { value: "anything legal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Nothing was changed.")).toBeVisible();
    expect(rule.value).toBe("anything legal");
    expect(puts).toEqual([]);
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
    const m = await live(HIGH);
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
    fireEvent.click(await live(HIGH));
    expect(await screen.findByText(/Nothing was changed\.$/)).toBeVisible();
    expect(await sw(HIGH)).toHaveAttribute("aria-checked", "true");
  });

  it("the mock: off or a new rule without an assertion is passkey_required; on is not", async () => {
    use("usable");
    const patch = (b: object) =>
      fetch(R.passkeySettings, {
        method: "PATCH",
        headers: { "content-type": "application/json", "X-OA-Request": "1" },
        body: JSON.stringify(b),
      });
    const on = { highStakes: true, everyAnswer: true, ownRule: "" };
    const first = await patch(on);
    expect(first.status, await first.clone().text()).toBe(200);
    for (const b of [
      { ...on, everyAnswer: false },
      { ...on, highStakes: false },
      { ...on, ownRule: "x" },
    ]) {
      const r = await patch(b);
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({
        error: { code: "passkey_required" },
      });
    }
    expect((await patch({ ...on, ownRule: "x".repeat(501) })).status).toBe(400);
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
      "This is your only passkey. Without one, you can't approve high-stakes decisions here until you add another.",
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

  it("with no usable passkey, removing skips the prompt and DELETEs for a fresh login", async () => {
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
    fireEvent.click(addBtn());
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

  it("a second passkey takes two clicks: approve (challenge, prompt, begin), then Create passkey (create, finish)", async () => {
    use("usable");
    const posts = calls("POST");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(addBtn());
    const next = await screen.findByRole("button", { name: "Add passkey" });
    expect(
      screen.getByText(
        "Your current passkey was accepted. Now add the new one.",
      ),
    ).toBeVisible();
    expect(next).toHaveFocus();
    // One primary action: the header button steps back, the sign-in note goes.
    const header = addBtn();
    expect(header).toHaveAttribute("aria-disabled", "true");
    expect(header.className).not.toMatch(/bg-primary/);
    expect(screen.queryByText(/asks you to log in again first/)).toBeNull();
    fireEvent.click(header);
    expect(get).toHaveBeenCalledTimes(1);
    const paths = posts.map((c) => c.path);
    expect(paths.indexOf(R.passkeyRegisterChallenge)).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf(R.passkeyRegisterChallenge)).toBeLessThan(
      paths.indexOf(R.passkeyRegisterBegin),
    );
    expect(posts.find((c) => c.path === R.passkeyRegisterBegin)?.body).toEqual({
      assertion: ASSERTION,
    });
    // One prompt per click: nothing is created until the second click.
    expect(get).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(posts.some((c) => c.path === R.passkeyRegisterFinish)).toBe(false);

    fireEvent.click(next);
    expect(await screen.findByText("Passkey")).toBeVisible();
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(posts.find((c) => c.path === R.passkeyRegisterFinish)?.body).toEqual(
      { credential: CREDENTIAL },
    );
    expect(screen.queryByRole("button", { name: "Add passkey" })).toBeNull();
  });

  it("an only usable passkey that is pending removal still approves adding one", async () => {
    use("usable");
    server.use(
      http.get(`*${R.passkeys}`, () =>
        HttpResponse.json([
          {
            id: "pk_a",
            label: "MacBook",
            createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
            lastUsedAt: null,
            usableAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
            usable: true,
            removesAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
          },
        ]),
      ),
    );
    const posts = calls("POST");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(addBtn());
    await screen.findByRole("button", { name: "Add passkey" });
    expect(posts.some((c) => c.path === R.passkeyRegisterChallenge)).toBe(true);
    expect(posts.find((c) => c.path === R.passkeyRegisterBegin)?.body).toEqual({
      assertion: ASSERTION,
    });
  });

  it("a cancelled create keeps Create passkey; an expired one (410) starts over", async () => {
    use("usable");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(addBtn());
    const next = await screen.findByRole("button", { name: "Add passkey" });
    create.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    fireEvent.click(next);
    expect(await screen.findByText("Nothing was added.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add passkey" })).toBeVisible();

    server.use(
      http.post(`*${R.passkeyRegisterFinish}`, () =>
        err("challenge_expired", 410),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    expect(
      await screen.findByText(
        "That took too long. Try again. Nothing was added.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add passkey" })).toBeNull();
  });

  it("a device that already has one (InvalidStateError on create) clears the approval and says so", async () => {
    use("usable");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(addBtn());
    const next = await screen.findByRole("button", { name: "Add passkey" });
    create.mockRejectedValueOnce(new DOMException("dup", "InvalidStateError"));
    fireEvent.click(next);
    expect(
      await screen.findByText(
        "This device already has a passkey for this account. Nothing was added.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add passkey" })).toBeNull();
    // The header button is back: not aria-disabled, primary again.
    const header = addBtn();
    expect(header).not.toHaveAttribute("aria-disabled");
    expect(header.className).toMatch(/bg-primary/);
  });

  it("a cancelled approval adds nothing: no begin, no create", async () => {
    use("usable");
    get.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    const posts = calls("POST");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(addBtn());
    expect(await screen.findByText("Nothing was added.")).toBeVisible();
    expect(posts.some((c) => c.path === R.passkeyRegisterBegin)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("adding while every passkey is cooling says when one can approve, and nothing was added", async () => {
    use("cooling");
    const posts = calls("POST");
    let usableAt = "";
    server.use(
      http.get(`*${R.passkeys}`, () => {
        usableAt = new Date(Date.now() + 7 * 3600_000).toISOString();
        return HttpResponse.json([
          {
            id: "pk_c",
            label: "This laptop",
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            usableAt,
            usable: false,
            removesAt: null,
          },
        ]);
      }),
      // The server answers at the challenge (any passkey row means approval).
      http.post(`*${R.passkeyRegisterChallenge}`, () =>
        err("passkey_cooling", 409, { usableAt }),
      ),
    );
    mount("/settings/security");
    await screen.findByText("This laptop");
    fireEvent.click(addBtn());
    const line = await screen.findByText(
      /^Your new passkey can approve from .+\. Nothing was added\.$/,
    );
    expect(line).toHaveTextContent(webauthn.coolingTime(usableAt));
    // No prompt was shown, nothing began, nothing was created.
    expect(posts.some((c) => c.path === R.passkeyRegisterBegin)).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("a passkey_cooling 409 from the challenge is shown, not treated as 'no approval needed'", async () => {
    use("usable");
    const usableAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    server.use(
      http.post(`*${R.passkeyRegisterChallenge}`, () =>
        err("passkey_cooling", 409, { usableAt }),
      ),
    );
    const posts = calls("POST");
    mount("/settings/security");
    await screen.findByText("MacBook");
    fireEvent.click(addBtn());
    const line = await screen.findByText(
      /^Your new passkey can approve from .+\. Nothing was added\.$/,
    );
    expect(line).toHaveTextContent(webauthn.coolingTime(usableAt));
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
    fireEvent.click(addBtn());
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
    fireEvent.click(addBtn());
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    expect(get).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("oa.passkey.addAfterReauth")).not.toBeNull();
  });

  it("a cancelled add says nothing was added", async () => {
    use("none");
    create.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    fireEvent.click(addBtn());
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
    fireEvent.click(addBtn());
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
    fireEvent.click(addBtn());
    expect(await screen.findByText(/Nothing was added\.$/)).toBeVisible();
    expect(redirect).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("oa.passkey.addAfterReauth")).toBeNull();
  });
});

describe("Settings › Security: stale state, return from login, pending removal", () => {
  afterEach(() => sessionStorage.clear());

  it("builds a switch change from the server's state, not the cached one", async () => {
    const s = settingsServer(base);
    mount("/settings/security");
    const high = await live(HIGH);
    // Another tab set a rule: the server now differs from the cache.
    server.use(
      http.get(`*${R.passkeySettings}`, () =>
        HttpResponse.json({ ...base, ownRule: "anything legal" }),
      ),
    );
    fireEvent.click(high);
    await waitFor(() => expect(s.puts.length).toBe(1));
    expect(s.challenges).toEqual([
      { highStakes: false, everyAnswer: false, ownRule: "anything legal" },
    ]);
  });

  it("says the device already has a passkey (InvalidStateError)", async () => {
    use("none");
    create.mockRejectedValue(new DOMException("dup", "InvalidStateError"));
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    fireEvent.click(addBtn());
    expect(
      await screen.findByText(
        "This device already has a passkey for this account. Nothing was added.",
      ),
    ).toBeVisible();
  });

  it("always says Add asks you to log in again", async () => {
    use("none");
    mount("/settings/security");
    expect(
      await screen.findByText(
        "Adding a passkey asks you to log in again first.",
      ),
    ).toBeVisible();
  });

  it("marks the return before following the login, only when it follows", async () => {
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
    fireEvent.click(addBtn());
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
  });

  it("back from the login: clears the mark, focuses Add, says so, does not call create", async () => {
    use("none");
    sessionStorage.setItem("oa.passkey.addAfterReauth", String(Date.now()));
    mount("/settings/security");
    const add = await screen.findByRole("button", { name: "Add a passkey" });
    expect(
      await screen.findByText(
        "You're logged in again. Add your passkey within 10 minutes.",
      ),
    ).toBeVisible();
    expect(add).toHaveFocus();
    expect(sessionStorage.getItem("oa.passkey.addAfterReauth")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    // The green line replaces the "sign in again first" note.
    expect(screen.queryByText(/asks you to log in again first/)).toBeNull();
  });

  it("a mark older than 10 minutes is cleared and ignored", async () => {
    use("none");
    sessionStorage.setItem(
      "oa.passkey.addAfterReauth",
      String(Date.now() - 11 * 60_000),
    );
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    expect(screen.queryByText(/logged in again\./)).toBeNull();
    expect(sessionStorage.getItem("oa.passkey.addAfterReauth")).toBeNull();
    expect(
      screen.getByText("Adding a passkey asks you to log in again first."),
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
    expect(screen.queryByText(/logged in again/)).toBeNull();
  });

  it("Add keeps focus while adding", async () => {
    use("none");
    create.mockReturnValue(new Promise(() => {}));
    mount("/settings/security");
    await screen.findByText("No passkeys yet.");
    const add = addBtn();
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
