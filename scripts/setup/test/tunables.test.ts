import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import { applyTunables, renderConfig } from "../src/steps/resources.ts";
import {
  normalizeVar,
  parseVarFlags,
  resolveVars,
  TUNABLES,
} from "../src/tunables.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
const TEMPLATE = readFileSync(
  join(import.meta.dirname, "../../../apps/server/wrangler.template.jsonc"),
  "utf8",
);
const ID = "3mQ7vK2xN8pRtYw5";
type W = ReturnType<typeof world>;
const cfgVars = (w: W) => JSON.parse(w.files.get(CONFIG) ?? "").vars;
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const err = (name: string, value: string) => {
  try {
    parseVarFlags([`${name}=${value}`]);
  } catch (e) {
    return (e as Error).message;
  }
};

describe("validators", () => {
  it("the allowlist is exactly the nine tunables", () => {
    expect(Object.keys(TUNABLES).sort()).toEqual([
      "ANON_WRITES_PER_MIN",
      "DATA_DAILY_WRITES",
      "DATA_DOC_BYTES",
      "EMBED_ALLOW_SAME_SITE",
      "EMBED_ORIGINS",
      "FREE_DATA_DAILY_WRITES",
      "FREE_DATA_DOCS",
      "FREE_STORAGE_BYTES",
      "PUBLIC_HOME",
    ]);
  });

  it("PUBLIC_HOME: an artifact id, or empty to clear", () => {
    expect(err("PUBLIC_HOME", ID)).toBeUndefined();
    expect(err("PUBLIC_HOME", "")).toBeUndefined();
    expect(err("PUBLIC_HOME", "short")).toMatch(/PUBLIC_HOME/);
    expect(err("PUBLIC_HOME", `${ID}0`)).toMatch(/PUBLIC_HOME/);
  });

  it("EMBED_ORIGINS: https origins only, no paths or wildcards", () => {
    expect(err("EMBED_ORIGINS", "https://a.example.com")).toBeUndefined();
    expect(
      err("EMBED_ORIGINS", "https://a.example.com,https://b.test:8443"),
    ).toBeUndefined();
    expect(err("EMBED_ORIGINS", "")).toBeUndefined();
    for (const bad of [
      "http://a.example.com",
      "https://a.example.com/",
      "https://a.example.com/x",
      "https://*.example.com",
      "a.example.com",
      "https://a.example.com,",
      "https://a.example.com, https://b.test",
      "https://a.example.com?x=1",
      "https://user@a.example.com",
    ])
      expect(err("EMBED_ORIGINS", bad), bad).toMatch(/EMBED_ORIGINS/);
  });

  it("EMBED_ALLOW_SAME_SITE: exactly 1, or empty to clear", () => {
    expect(err("EMBED_ALLOW_SAME_SITE", "1")).toBeUndefined();
    expect(err("EMBED_ALLOW_SAME_SITE", "")).toBeUndefined();
    for (const bad of ["0", "true", "on", "11", " 1", "yes"])
      expect(err("EMBED_ALLOW_SAME_SITE", bad), bad).toMatch(
        /EMBED_ALLOW_SAME_SITE/,
      );
  });

  it("EMBED_ALLOW_SAME_SITE renders as a string var", () => {
    const text = applyTunables('{\n  "vars": {\n    "PLAN": "free"\n  }\n}', {
      EMBED_ALLOW_SAME_SITE: "1",
    });
    expect(JSON.parse(text).vars.EMBED_ALLOW_SAME_SITE).toBe("1");
  });

  it("ANON_WRITES_PER_MIN: an integer 1 to 600", () => {
    for (const ok of ["1", "120", "600"])
      expect(err("ANON_WRITES_PER_MIN", ok)).toBeUndefined();
    for (const bad of ["0", "601", "-1", "1.5", "abc", " 5", "1e2"])
      expect(err("ANON_WRITES_PER_MIN", bad), bad).toMatch(
        /ANON_WRITES_PER_MIN/,
      );
  });

  it("DATA_DOC_BYTES and DATA_DAILY_WRITES: positive integers", () => {
    for (const n of ["DATA_DOC_BYTES", "DATA_DAILY_WRITES"]) {
      expect(err(n, "262144")).toBeUndefined();
      for (const bad of ["0", "-3", "1.5", "x", "01x"])
        expect(err(n, bad), `${n}=${bad}`).toMatch(new RegExp(n));
    }
  });

  it("the free-plan caps: positive integers up to 2^53-1", () => {
    for (const n of [
      "FREE_STORAGE_BYTES",
      "FREE_DATA_DOCS",
      "FREE_DATA_DAILY_WRITES",
    ]) {
      for (const ok of ["1", String(2 ** 53 - 1)])
        expect(err(n, ok), `${n}=${ok}`).toBeUndefined();
      for (const bad of ["0", "-1", "1.5", String(2 ** 53)])
        expect(err(n, bad), `${n}=${bad}`).toMatch(new RegExp(n));
    }
  });

  it("every var can be cleared with an empty value", () => {
    for (const n of Object.keys(TUNABLES))
      expect(err(n, ""), n).toBeUndefined();
  });

  it("an unknown name or a missing = is rejected, naming the allowed vars", () => {
    expect(err("PLAN", "paid")).toMatch(/unknown.*PLAN.*PUBLIC_HOME/s);
    expect(() => parseVarFlags(["PUBLIC_HOME"])).toThrow(/NAME=value/);
    expect(() => parseVarFlags(["=x"])).toThrow();
  });

  it("parses repeated flags; the last one for a name wins; values may hold =", () => {
    expect(
      parseVarFlags(["ANON_WRITES_PER_MIN=5", "ANON_WRITES_PER_MIN=7"]),
    ).toEqual({ ANON_WRITES_PER_MIN: "7" });
    expect(parseVarFlags(undefined)).toEqual({});
  });
});

describe("resolveVars precedence", () => {
  const live = {
    PUBLIC_HOME: ID,
    ANON_WRITES_PER_MIN: "50",
    DATA_DOC_BYTES: "1000",
  };
  it("flag, then state, then live, then nothing", () => {
    const r = resolveVars({
      flags: { PUBLIC_HOME: "" },
      state: { ANON_WRITES_PER_MIN: "120" },
      live,
    });
    expect(r.values).toEqual({
      PUBLIC_HOME: "",
      ANON_WRITES_PER_MIN: "120",
      DATA_DOC_BYTES: "1000",
    });
  });

  it("notes only the values kept from the live Worker", () => {
    const r = resolveVars({
      flags: { PUBLIC_HOME: "" },
      state: { ANON_WRITES_PER_MIN: "120" },
      live,
    });
    expect(r.kept).toEqual(["DATA_DOC_BYTES=1000"]);
  });

  it("an empty flag clears even a live and a saved value", () => {
    const r = resolveVars({
      flags: { PUBLIC_HOME: "" },
      state: { PUBLIC_HOME: "abc" },
      live,
    });
    expect(r.values.PUBLIC_HOME).toBe("");
    expect(r.kept).not.toContain(`PUBLIC_HOME=${ID}`);
  });

  it("a saved empty value beats live; names outside the allowlist are ignored", () => {
    const r = resolveVars({
      flags: {},
      state: { PUBLIC_HOME: "" },
      live: { ...live, PLAN: "paid" },
    });
    expect(r.values.PUBLIC_HOME).toBe("");
    expect(r.values).not.toHaveProperty("PLAN");
  });
});

describe("EMBED_ORIGINS normalization", () => {
  it("lowercases hosts, drops :443, dedupes, keeps order", () => {
    expect(
      parseVarFlags([
        "EMBED_ORIGINS=https://A.Example.com:443,https://b.test:8443,https://a.example.com",
      ]).EMBED_ORIGINS,
    ).toBe("https://a.example.com,https://b.test:8443");
    expect(normalizeVar("EMBED_ORIGINS", "https://x.test:0443")).toBe(
      "https://x.test",
    );
    expect(normalizeVar("PUBLIC_HOME", "AbC")).toBe("AbC");
  });

  it("ports must be 1 to 65535", () => {
    for (const bad of ["0", "65536", "99999"])
      expect(err("EMBED_ORIGINS", `https://a.test:${bad}`), bad).toMatch(
        /EMBED_ORIGINS/,
      );
    expect(err("EMBED_ORIGINS", "https://a.test:65535")).toBeUndefined();
    expect(err("EMBED_ORIGINS", "https://a.test:1")).toBeUndefined();
  });

  it("saved and live values render normalized too", () => {
    const r = resolveVars({
      flags: {},
      state: { EMBED_ORIGINS: "https://A.test:443,https://a.test" },
      live: {},
    });
    expect(r.values.EMBED_ORIGINS).toBe("https://a.test");
  });
});

describe("saved values are re-validated", () => {
  it("drops an invalid saved value and falls back to live, then nothing", () => {
    const r = resolveVars({
      flags: {},
      state: { ANON_WRITES_PER_MIN: "9999", DATA_DOC_BYTES: "x" },
      live: { ANON_WRITES_PER_MIN: "60" },
    });
    expect(r.values).toEqual({ ANON_WRITES_PER_MIN: "60" });
    expect(r.ignoredSaved.sort()).toEqual([
      "ANON_WRITES_PER_MIN",
      "DATA_DOC_BYTES",
    ]);
    expect(r.kept).toEqual(["ANON_WRITES_PER_MIN=60"]);
  });

  it("setup notes 'ignored invalid saved NAME'", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    const st = w.state();
    st.vars = { ANON_WRITES_PER_MIN: "0" };
    w.files.set(STATE, JSON.stringify(st));
    w.lines.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toContain(
      "ignored invalid saved ANON_WRITES_PER_MIN",
    );
    expect(cfgVars(w).ANON_WRITES_PER_MIN ?? "").toBe("");
  });
});

describe("unreadable live vars", () => {
  it("warns naming the allowlisted vars not in state or flags", async () => {
    const w2 = world({ settingsFail: true });
    const code = await run(
      [...HOSTS, "--plan", "free", "--var", "ANON_WRITES_PER_MIN=5"],
      w2.deps,
      ROOT,
    );
    const msg = (line(w2, "deploy") ?? {}).message ?? w2.lines.join("\n");
    expect(msg).toContain("could not read live vars; dashboard-set");
    expect(msg).toContain("PUBLIC_HOME");
    expect(msg).not.toMatch(/dashboard-set[^;]*ANON_WRITES_PER_MIN/);
    expect(code).toBeDefined();
  });
});

describe("live values are validated", () => {
  it("drops an invalid live value, reports it, and falls back", () => {
    const r = resolveVars({
      flags: {},
      state: {},
      live: {
        ANON_WRITES_PER_MIN: "9999",
        PUBLIC_HOME: "nope",
        DATA_DOC_BYTES: "5",
      },
    });
    expect(r.values).toEqual({ DATA_DOC_BYTES: "5" });
    expect(r.ignored.sort()).toEqual(["ANON_WRITES_PER_MIN", "PUBLIC_HOME"]);
    expect(r.kept).toEqual(["DATA_DOC_BYTES=5"]);
  });

  it("a saved value still beats an invalid live one, with no note needed for it", () => {
    const r = resolveVars({
      flags: {},
      state: { ANON_WRITES_PER_MIN: "5" },
      live: { ANON_WRITES_PER_MIN: "x" },
    });
    expect(r.values.ANON_WRITES_PER_MIN).toBe("5");
  });

  it("setup notes 'ignored invalid live NAME' and does not render it", async () => {
    const w = world({
      workerBindings: [
        { type: "plain_text", name: "ANON_WRITES_PER_MIN", text: "9999" },
      ],
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toContain(
      "ignored invalid live ANON_WRITES_PER_MIN",
    );
    expect(cfgVars(w).ANON_WRITES_PER_MIN ?? "").toBe("");
  });
});

describe("renderConfig tunables", () => {
  const lastVar = `{
  "name": "x",
  "vars": {
    "ENVIRONMENT": "production",
    "PLAN": "free",
    "PUBLIC_HOME": ""
  }
}`;
  it("keeps strict JSON when a tunable is the last var: set, then cleared", () => {
    const set = applyTunables(lastVar, { PUBLIC_HOME: ID });
    expect(JSON.parse(set).vars.PUBLIC_HOME).toBe(ID);
    const set2 = applyTunables(set, { PUBLIC_HOME: "" });
    expect(JSON.parse(set2).vars).toEqual({
      ENVIRONMENT: "production",
      PLAN: "free",
    });
    const added = applyTunables(lastVar, { EMBED_ORIGINS: "https://a.test" });
    expect(JSON.parse(added).vars.EMBED_ORIGINS).toBe("https://a.test");
    expect(JSON.parse(added).vars.PUBLIC_HOME).toBe("");
  });

  it("leaves the text alone with nothing to set", () => {
    expect(applyTunables(lastVar, {})).toBe(lastVar);
  });

  const vars = {
    WORKER_NAME: "w",
    APP_HOST: "a.example.com",
    CONTENT_HOST: "c.example.com",
    OWNER_EMAIL: "o@example.com",
    D1_NAME: "d",
    D1_ID: "d1",
    R2_BUCKET: "r",
    KV_ID: "k",
    CF_ACCOUNT_ID: "acc",
    ACCESS_TEAM_DOMAIN: "t",
    ACCESS_CLIENT_ID: "c",
  };
  it("renders set values into vars as strings, as strict JSON", () => {
    const text = renderConfig(TEMPLATE, vars, true, false, "free", {
      PUBLIC_HOME: ID,
      ANON_WRITES_PER_MIN: "120",
    });
    const v = JSON.parse(text).vars;
    expect(v.PUBLIC_HOME).toBe(ID);
    expect(v.ANON_WRITES_PER_MIN).toBe("120");
    expect(v.ENVIRONMENT).toBe("production");
  });

  it("an empty value is not rendered, and no tunables leaves the template as is", () => {
    const empty = JSON.parse(
      renderConfig(TEMPLATE, vars, true, false, "free", { PUBLIC_HOME: "" }),
    ).vars;
    expect(empty.PUBLIC_HOME ?? "").toBe("");
    expect(renderConfig(TEMPLATE, vars)).toBe(
      renderConfig(TEMPLATE, vars, true, false, "free", {}),
    );
  });

  it("replaces a template default instead of duplicating the key", () => {
    const t = TEMPLATE.replace(
      '"SERVER_THUMBNAILS": "on",',
      '"SERVER_THUMBNAILS": "on",\n    "PUBLIC_HOME": "",',
    );
    const text = renderConfig(t, vars, true, false, "free", {
      PUBLIC_HOME: ID,
    });
    expect(text.match(/"PUBLIC_HOME"/g)).toHaveLength(1);
    expect(JSON.parse(text).vars.PUBLIC_HOME).toBe(ID);
  });
});

describe("setup --var", () => {
  it("--help documents --var", () => {
    expect(HELP).toContain("--var");
  });

  it("renders the flag into the config, saves it in state.vars and reports it", async () => {
    const w = world();
    const code = await run(
      [
        ...HOSTS,
        "--var",
        `PUBLIC_HOME=${ID}`,
        "--var",
        "ANON_WRITES_PER_MIN=120",
      ],
      w.deps,
      ROOT,
    );
    expect(code).toBe(0);
    expect(cfgVars(w)).toMatchObject({
      PUBLIC_HOME: ID,
      ANON_WRITES_PER_MIN: "120",
    });
    expect(w.state().vars).toEqual({
      PUBLIC_HOME: ID,
      ANON_WRITES_PER_MIN: "120",
    });
    expect(line(w, "deploy").data.vars).toEqual({
      PUBLIC_HOME: ID,
      ANON_WRITES_PER_MIN: "120",
    });
  });

  it("a later run without the flag keeps the saved value", async () => {
    const w = world();
    await run([...HOSTS, "--var", "ANON_WRITES_PER_MIN=120"], w.deps, ROOT);
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(cfgVars(w).ANON_WRITES_PER_MIN).toBe("120");
  });

  it("keeps a live (dashboard-set) value missing from state, with a note", async () => {
    const w = world({
      workerBindings: [{ type: "plain_text", name: "PUBLIC_HOME", text: ID }],
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(cfgVars(w).PUBLIC_HOME).toBe(ID);
    expect(line(w, "deploy").message).toContain(`kept live PUBLIC_HOME=${ID}`);
    expect(w.state().vars).toEqual({ PUBLIC_HOME: ID });
  });

  it("the flag beats the live value, with no kept note", async () => {
    const w = world({
      workerBindings: [
        { type: "plain_text", name: "ANON_WRITES_PER_MIN", text: "50" },
      ],
    });
    await run([...HOSTS, "--var", "ANON_WRITES_PER_MIN=120"], w.deps, ROOT);
    expect(cfgVars(w).ANON_WRITES_PER_MIN).toBe("120");
    expect(line(w, "deploy").message).not.toContain("kept live");
  });

  it("--var NAME= clears a live value", async () => {
    const w = world({
      workerBindings: [{ type: "plain_text", name: "PUBLIC_HOME", text: ID }],
    });
    const code = await run([...HOSTS, "--var", "PUBLIC_HOME="], w.deps, ROOT);
    expect(code).toBe(0);
    expect(cfgVars(w).PUBLIC_HOME ?? "").toBe("");
    expect(line(w, "deploy").data.vars).toBeUndefined();
    expect(w.state().vars).toBeUndefined();
  });

  it("--var NAME= clears a saved value, and it stays cleared", async () => {
    const w = world();
    await run([...HOSTS, "--var", "ANON_WRITES_PER_MIN=120"], w.deps, ROOT);
    const code = await run(
      [...HOSTS, "--var", "ANON_WRITES_PER_MIN="],
      w.deps,
      ROOT,
    );
    expect(code).toBe(0);
    expect(cfgVars(w).ANON_WRITES_PER_MIN ?? "").toBe("");
    expect(w.state().vars).toBeUndefined();
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(cfgVars(w).ANON_WRITES_PER_MIN ?? "").toBe("");
  });

  it("an unknown name or invalid value exits 1 before anything runs", async () => {
    for (const bad of [
      "PLAN=paid",
      "PUBLIC_HOME=nope",
      "ANON_WRITES_PER_MIN=0",
    ]) {
      const w = world();
      expect(await run([...HOSTS, "--var", bad], w.deps, ROOT)).toBe(1);
      expect(w.lines.join("\n")).toContain(bad.split("=")[0]);
      expect(w.ops).toEqual([]);
      expect(w.files.has(STATE)).toBe(false);
    }
  });

  it("--check reports the effective vars on the deploy line", async () => {
    const w = world();
    await run([...HOSTS, "--var", "ANON_WRITES_PER_MIN=120"], w.deps, ROOT);
    w.lines.length = 0;
    await run([...HOSTS, "--check", "--json"], w.deps, ROOT);
    expect(line(w, "deploy").data.vars).toEqual({ ANON_WRITES_PER_MIN: "120" });
  });
});
