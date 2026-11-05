import { describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const CI = [...HOSTS.filter((a) => a !== "--yes"), "--ci"];
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, s: string) => parsed(w).find((j) => j.step === s);

/** The PAT is learned from what the app host saw; it must appear nowhere else. */
function noPat(w: W) {
  expect(w.bearers.size).toBeGreaterThan(0);
  const decoded = w.lines.map((l) => JSON.stringify(JSON.parse(l)));
  const hay = [
    ...w.lines,
    ...decoded,
    ...w.files.values(),
    ...w.argv,
    ...w.prompts,
    ...w.sqls,
    ...w.values,
    ...w.execOut,
    JSON.stringify(w.deps.env),
    JSON.stringify(process.env),
  ].join("\n");
  for (const pat of w.bearers) {
    expect(pat).toMatch(/^oa_pat_/);
    expect(hay.includes(pat), "PAT leaked").toBe(false);
  }
  expect(/oa_pat_/.test(hay), "PAT leaked").toBe(false);
}
const REVOKE = /^UPDATE tokens SET revoked_at = \d+ WHERE id = '(\w+)'/;
const revokes = (w: W) => w.sqls.filter((s) => REVOKE.test(s));

describe("--ci", () => {
  it("never leaks the PAT into lines, json, files, state, argv or env", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    noPat(w);
    expect(line(w, "owner-token").message).toContain(
      "owner token minted for selftest (not printed; revoked at end of run)",
    );
    expect(line(w, "selftest").data.mcp).toBe("ok");
    expect(w.files.has(STATE)).toBe(false);
    expect(w.db.tokens.map((t) => t.label)).toEqual(["setup-ci"]);
  });

  it("revokes the minted token after a successful selftest", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    const last = parsed(w).at(-1);
    expect(last).toMatchObject({ step: "revoke-ci-token", status: "ok" });
    expect(revokes(w)).toHaveLength(1);
    expect(w.db.tokens[0].revoked_at).toBeGreaterThan(0);
    expect(w.sqls.findIndex((s) => REVOKE.test(s))).toBe(w.sqls.length - 1);
  });

  it("revokes even when selftest fails", async () => {
    const w = world({ noPublishTool: true });
    expect(await run(CI, w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest").status).toBe("error");
    expect(parsed(w).at(-1)).toMatchObject({
      step: "revoke-ci-token",
      status: "ok",
    });
    expect(w.db.tokens[0].revoked_at).toBeGreaterThan(0);
    noPat(w);
  });

  it("a failed revocation exits non-zero and names the token id, not the token", async () => {
    const w = world({
      failOn: /^UPDATE tokens SET revoked_at = \d+ WHERE id =/,
    });
    const code = await run(CI, w.deps, ROOT);
    expect(code).not.toBe(0);
    const l = parsed(w).at(-1);
    expect(l).toMatchObject({ step: "revoke-ci-token", status: "error" });
    expect(l.message).toContain(w.db.tokens[0].id);
    expect(l.message).toContain("Settings");
    noPat(w);
  });

  it("agent-config carries no token and points to the dashboard", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    const d = line(w, "agent-config");
    expect(d.data.snippets.json).toContain("<YOUR_TOKEN>");
    expect(JSON.stringify(d)).toContain("Settings → Connections");
    expect(JSON.stringify(d)).not.toContain("owner-token step");
  });

  it("never prompts and prints only json lines with no PAT", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    expect(w.prompts).toEqual([]);
    for (const l of w.lines) expect(() => JSON.parse(l)).not.toThrow();
    noPat(w);
  });

  it("a fetch error echoing URL and headers never leaks the PAT", async () => {
    const w = world({
      mcpThrows: (t) =>
        `fetch failed: POST https://app.example.com/mcp headers={authorization: Bearer ${t}}`,
    });
    expect(await run(CI, w.deps, ROOT)).toBe(1);
    const sel = line(w, "selftest");
    expect(sel.status).toBe("error");
    expect(sel.message).toContain("https://app.example.com/mcp");
    expect(parsed(w).at(-1)).toMatchObject({
      step: "revoke-ci-token",
      status: "ok",
    });
    noPat(w);
  });

  it("SIGTERM mid-selftest revokes once, prints only the id, exits 143", async () => {
    const handlers: Record<string, () => void> = {};
    const exits: number[] = [];
    const w = world({
      onMcp: (m) => {
        if (m === "tools/list") handlers.SIGTERM?.();
      },
    });
    w.deps.onSignal = (sig, h) => {
      handlers[sig] = h;
      return () => delete handlers[sig];
    };
    w.deps.exit = (c) => void exits.push(c);
    await run(CI, w.deps, ROOT);
    await vi.waitFor(() => expect(exits).toEqual([143]));
    expect(revokes(w)).toHaveLength(1);
    expect(w.db.tokens[0].revoked_at).toBeGreaterThan(0);
    const rev = parsed(w).filter((j) => j.step === "revoke-ci-token");
    expect(rev).toHaveLength(1);
    expect(rev[0].message).toContain(w.db.tokens[0].id);
    expect(handlers).toEqual({});
    noPat(w);
  });

  it("SIGINT exits 130", async () => {
    const handlers: Record<string, () => void> = {};
    const exits: number[] = [];
    const w = world({
      onMcp: (m) => m === "initialize" && handlers.SIGINT?.(),
    });
    w.deps.onSignal = (sig, h) => {
      handlers[sig] = h;
      return () => delete handlers[sig];
    };
    w.deps.exit = (c) => void exits.push(c);
    await run(CI, w.deps, ROOT);
    await vi.waitFor(() => expect(exits).toEqual([130]));
  });

  it("cleans leaked setup-ci tokens before the capped insert, then mints", async () => {
    const tokens = [
      ...Array.from({ length: 48 }, (_, i) => ({
        id: `t${i}`,
        user_id: "u1",
        label: "laptop",
        token_hash: `h${i}`,
      })),
      ...["leak1", "leak2"].map((id) => ({
        id,
        user_id: "u1",
        label: "setup-ci",
        token_hash: id,
      })),
    ];
    const w = world({
      seed: {
        users: [{ id: "u1", email: "owner@example.com", role: "owner" }],
        tokens,
      },
    });
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    const t = (id: string) => w.db.tokens.find((x) => x.id === id);
    expect(t("leak1").revoked_at).toBeGreaterThan(0);
    expect(t("leak2").revoked_at).toBeGreaterThan(0);
    expect(t("t0").revoked_at).toBeUndefined();
    expect(line(w, "owner-token").message).toContain("2 stale setup-ci");
    expect(line(w, "selftest").data.mcp).toBe("ok");
  });

  it("--revoke-ci-tokens revokes every live setup-ci token and exits", async () => {
    const mk = (id: string, label: string, extra = {}) => ({
      id,
      user_id: "u1",
      label,
      token_hash: id,
      ...extra,
    });
    const w = world({
      seed: {
        users: [{ id: "u1", email: "owner@example.com", role: "owner" }],
        tokens: [
          mk("a", "setup-ci"),
          mk("b", "setup-ci"),
          mk("c", "setup-ci", { revoked_at: 5 }),
          mk("d", "setup"),
          mk("e", "laptop"),
        ],
      },
    });
    const argv = [...CI, "--revoke-ci-tokens"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(parsed(w)).toEqual([
      {
        step: "revoke-ci-tokens",
        status: "ok",
        message: "revoked 2 live setup-ci tokens",
        data: { revoked: 2 },
      },
    ]);
    const live = w.db.tokens.filter((x) => !x.revoked_at).map((x) => x.id);
    expect(live).toEqual(["d", "e"]);
    expect(w.ops).toEqual([]);
    expect(w.creates).toEqual([]);
  });

  it("--revoke-ci-tokens needs --ci and reports failure non-zero", async () => {
    const w = world();
    const no = HOSTS.filter((a) => a !== "--ci");
    expect(await run([...no, "--revoke-ci-tokens"], w.deps, ROOT)).toBe(1);
    expect(parsed(w)[0].message).toContain("--ci");
    const f = world({ failOn: /^UPDATE tokens/ });
    expect(await run([...CI, "--revoke-ci-tokens"], f.deps, ROOT)).toBe(1);
    expect(parsed(f)[0]).toMatchObject({ status: "error" });
  });

  it("reuses the welcome artifact by title across stateless runs", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    w.lines.length = 0;
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    const pubs = w.mcpCalls.filter((c) => c.name === "publish_artifact");
    // The second run finds the page by title and its latest text is unchanged.
    expect(pubs).toHaveLength(1);
  });

  it("without --name is an error", async () => {
    const w = world({ state: { name: "open-artifacts" } });
    const argv = CI.filter((a, i) => a !== "--name" && CI[i - 1] !== "--name");
    expect(await run(argv, w.deps, ROOT)).not.toBe(0);
    expect(parsed(w)[0].message).toContain("--ci requires --name");
    expect(w.creates).toEqual([]);
  });

  it("with --new-owner-token is an error", async () => {
    const w = world();
    expect(await run([...CI, "--new-owner-token"], w.deps, ROOT)).toBe(1);
    expect(parsed(w)[0].message).toContain("--new-owner-token");
  });

  it("an existing state file is left untouched", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const before = w.files.get(STATE);
    w.lines.length = 0;
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    expect(w.files.get(STATE)).toBe(before);
  });
});
