import { execFileSync } from "node:child_process";
import {
  hostSlug,
  R,
  SECRET_LABELS,
  secretFile,
  secretSnippet,
  type TokenCreated,
} from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import { snippets } from "../src/settings/snippets";
import * as h from "./harness";
import { installHarness, mount, server } from "./harness";

installHarness();

const URL_ = fixtures.me.instance.mcpUrl;
const SECRET = "oa_pat_SECRETSECRETSECRETSECRETSECRET12";
const FILE = secretFile("pat", { hostSlug: hostSlug(location.host) });
const all = (url: string) => snippets(url, { tokenFile: FILE });
/** Tokens have a Revoke button; agents keep Revoke… in their ••• menu. */
const startRevoke = async (name: string) => {
  const direct = screen.queryByRole("button", { name: `Revoke ${name}` });
  if (direct) return fireEvent.click(direct);
  fireEvent.pointerDown(
    await screen.findByRole("button", { name: `More for ${name}` }),
    { button: 0, pointerType: "mouse" },
  );
  fireEvent.click(
    within(await screen.findByRole("menu")).getByRole("menuitem", {
      name: "Revoke…",
    }),
  );
};

describe("snippets", () => {
  it("covers 5 agents over OAuth, 4 over a token file, url verbatim", () => {
    const list = all(URL_);
    expect(list.filter((s) => s.variant === "oauth")).toHaveLength(5);
    expect(
      list.filter((s) => s.variant === "token").map((s) => s.agent),
    ).toEqual(["Claude Code", "Codex CLI", "OpenCode", "Generic"]);
    for (const s of list)
      if (s.language !== "text") expect(s.code).toContain(URL_);
  });
  it("token variants read the token file and never embed a token", () => {
    expect(FILE).toBe("~/.open-artifacts/localhost-3000-pat-token");
    const tok = (agent: string) =>
      all(URL_).find((s) => s.agent === agent && s.variant === "token")?.code ??
      "";
    for (const s of all(URL_)) {
      expect(s.code).not.toContain("oa_pat_");
      expect(s.code).not.toContain("OA_TOKEN");
    }
    for (const s of all(URL_).filter((s) => s.variant === "token"))
      expect(s.code).toContain(FILE);
    expect(tok("Claude Code")).toContain('"headersHelper"');
    expect(tok("Codex CLI")).toContain("http_headers_helper = ");
    expect(tok("OpenCode")).toContain(
      `"Authorization": "Bearer {file:${FILE}}"`,
    );
    expect(tok("OpenCode")).toContain('"oauth": false');
    for (const s of all(URL_).filter((s) => s.variant === "oauth"))
      expect(s.code).not.toContain("Bearer");
  });
  it("escapes per language", () => {
    const evil = `https://x.test/mcp"'\\$(id)`;
    for (const s of all(evil)) {
      if (s.language === "json") {
        const v = JSON.stringify(JSON.parse(s.code));
        expect(v).toContain(JSON.stringify(evil).slice(1, -1));
      }
      if (s.language === "toml")
        expect(s.code).toContain(`url = ${JSON.stringify(evil)}`);
    }
  });
});

describe("Agents settings", () => {
  it("shows snippets with a copy button; a denied clipboard toasts danger", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mount("/settings/agents");
    const copy = await screen.findByRole("button", {
      name: /copy command|copy config/i,
    });
    expect(screen.getByText(/claude mcp add/)).toBeTruthy();
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await screen.findByText(/couldn't copy/i);
  });

  it("toggles to the Token variant", async () => {
    mount("/settings/agents");
    fireEvent.click(await screen.findByRole("radio", { name: "Token" }));
    expect((await screen.findAllByText(/headersHelper/))[0]).toBeTruthy();
  });

  it("keeps the Cursor tab in the Token variant with an OAuth note", async () => {
    mount("/settings/agents");
    fireEvent.click(await screen.findByRole("radio", { name: "Token" }));
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual([
      "Claude Code",
      "Codex CLI",
      "Cursor",
      "OpenCode",
      "Generic",
    ]);
    const cursor = screen.getByRole("tab", { name: "Cursor" });
    fireEvent.mouseDown(cursor);
    fireEvent.click(cursor);
    const panel = await screen.findByRole("tabpanel");
    expect(panel.textContent).toBe(
      "Cursor signs in with OAuth, so it doesn't need a token.",
    );
    expect(within(panel).queryByRole("button")).toBeNull();
  });

  it("revokes an OAuth client only after confirm, via DELETE", async () => {
    const deletes: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "DELETE")
        deletes.push(new URL(request.url).pathname);
    });
    mount("/settings/agents");
    await startRevoke("Example MCP client");
    expect(deletes).toEqual([]);
    const dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: /^revoke/i }));
    await waitFor(() =>
      expect(deletes).toEqual([
        R.oauthClient(fixtures.oauthClients[0]?.grantId ?? ""),
      ]),
    );
  });

  it("revokes a token via DELETE after confirm; null lastUsedAt reads Never", async () => {
    const deletes: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "DELETE")
        deletes.push(new URL(request.url).pathname);
    });
    mount("/settings/agents");
    await screen.findByText("laptop");
    expect(screen.getAllByText("Last used Never").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Revoke laptop" }));
    const dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: /^revoke/i }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toBe(R.token(fixtures.tokens[0]?.id ?? ""));
  });

  const created: TokenCreated = {
    id: "newtoken00000001",
    label: "ci",
    createdAt: "2026-01-03T00:00:00.000Z",
    lastUsedAt: null,
    token: SECRET,
  };
  const serveCreate = () =>
    server.use(
      http.post("*/api/v1/tokens", () =>
        HttpResponse.json(created, { status: 201 }),
      ),
    );
  const openCreate = async () => {
    fireEvent.click(
      await screen.findByRole("button", { name: "Create token" }),
    );
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Label"), {
      target: { value: "  ci  " },
    });
    return dlg;
  };
  const dump = () =>
    JSON.stringify([
      h.lastClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      h.lastClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ]);

  it("shows a created token once with the save command, then drops it on Done", async () => {
    let sent: unknown;
    server.use(
      http.post("*/api/v1/tokens", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    mount("/settings/agents");
    const dlg = await openCreate();
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    const shown = await screen.findByRole("dialog");
    await within(shown).findAllByText(SECRET);
    expect(sent).toEqual({ label: "ci" });
    expect(within(shown).getByText("You won't see this again.")).toBeTruthy();
    expect(within(shown).getAllByText(SECRET)).toHaveLength(1);
    expect(within(shown).getAllByText(SECRET)[0]?.closest("pre")).toBeNull();
    for (const pre of shown.querySelectorAll("pre"))
      expect(pre.textContent).not.toContain(SECRET);
    expect(shown.textContent).not.toContain("OA_TOKEN");
    expect(shown.textContent).toContain(
      "Save this token to a file so your agent can use it without it ever appearing in chat.",
    );
    expect(shown.textContent).toContain(
      "Then set up your client below. Never paste the token into chat or into a config file.",
    );
    expect(shown.textContent).toContain(
      "In Claude Code, type ! and a space, then paste the line.",
    );
    expect(shown.querySelector("kbd")?.textContent).toBe("!");
    const save = secretSnippet(FILE, SECRET_LABELS.pat);
    expect(
      [...shown.querySelectorAll("pre")].map((p) => p.textContent),
    ).toContain(save);
    expect(
      within(shown).getByRole("button", { name: "Copy save command" }),
    ).toBeTruthy();
    expect(dump()).not.toContain(SECRET);
    expect(localStorage.length).toBe(0);
    expect(location.href).not.toContain(SECRET);
    fireEvent.click(within(shown).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
    expect(dump()).not.toContain(SECRET);
  });

  it("keeps the page snippets on the token file after a token is created", async () => {
    serveCreate();
    mount("/settings/agents");
    const dlg = await openCreate();
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await screen.findAllByText(SECRET);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("radio", { name: "Token" }));
    expect(document.body.textContent).toContain(FILE);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("ignores Escape while creating and once the token is shown", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.post("*/api/v1/tokens", async () => {
        await gate;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    mount("/settings/agents");
    const dlg = await openCreate();
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    release();
    const shown = await screen.findByRole("dialog");
    await within(shown).findAllByText(SECRET);
    fireEvent.keyDown(shown, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("creates one token when the form is submitted twice", async () => {
    let posts = 0;
    server.use(
      http.post("*/api/v1/tokens", () => {
        posts++;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    mount("/settings/agents");
    const dlg = await openCreate();
    const form = within(dlg).getByLabelText("Label").closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findAllByText(SECRET);
    expect(posts).toBe(1);
  });

  it.each([
    ["token", "laptop", "*/api/v1/tokens/:id"],
    ["OAuth client", "Example MCP client", "*/api/v1/oauth-clients/:grantId"],
  ])(
    "a failed %s revoke shows a danger toast with the server message",
    async (_n, button, path) => {
      server.use(
        http.delete(path, () =>
          HttpResponse.json(
            { error: { code: "internal", message: "boom" } },
            { status: 500 },
          ),
        ),
      );
      mount("/settings/agents");
      await screen.findByText("laptop");
      await startRevoke(button);
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: /^revoke/i,
        }),
      );
      await screen.findAllByText(/couldn.t revoke/i, undefined, {
        timeout: 3000,
      });
      await screen.findAllByText("boom");
    },
  );
});

describe("snippets parse in their target format", () => {
  const evil = "https://x.test/mcp?a=\"b\"&c='d'\n$(id)`id`\\\t ";
  it("JSON, TOML and bash round-trip the url", () => {
    for (const s of all(evil)) {
      if (s.language === "json")
        expect(JSON.stringify(JSON.parse(s.code))).toContain("x.test");
      if (s.language === "toml") {
        const v = parseToml(s.code) as {
          mcp_servers: Record<string, { url: string }>;
        };
        expect(v.mcp_servers["open-artifacts"]?.url).toBe(evil);
      }
      if (s.language === "bash") {
        execFileSync("bash", ["-n", "-c", s.code]);
        const argv = execFileSync("bash", [
          "-c",
          `claude() { printf '%s\\0' "$@"; }; codex() { claude "$@"; }; ${s.code}`,
        ])
          .toString()
          .split("\0");
        // OAuth passes the url as an argument; add-json inside the config.
        const last = argv.at(-2) ?? "";
        expect(s.variant === "oauth" ? last : JSON.parse(last).url).toBe(evil);
      }
    }
  });
});
