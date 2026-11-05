import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentClients, TOKEN_PLACEHOLDER } from "../src/agent-clients.js";
import {
  DEFAULT_INSTALL_NAME,
  hostSlug,
  SECRET_ENV_VARS,
  SECRET_LABELS,
  secretFile,
  secretRules,
  secretSnippet,
} from "../src/secrets.js";

describe("secrets", () => {
  it("secretFile: install-name files and the host's PAT file", () => {
    expect(secretFile("cloudflare")).toBe(
      `~/.open-artifacts/${DEFAULT_INSTALL_NAME}-cloudflare-token`,
    );
    expect(secretFile("analytics", { installName: "acme" })).toBe(
      "~/.open-artifacts/acme-analytics-token",
    );
    expect(secretFile("pat", { hostSlug: hostSlug("Oa.Example.com") })).toBe(
      "~/.open-artifacts/oa-example-com-pat-token",
    );
    expect(() => secretFile("pat")).toThrow();
  });

  // Platform's final template (task D, tokens.ts at e89dc02, confirmed
  // 2026-10-20); setup imports this function once D lands.
  it("secretSnippet is Platform's final template, pinned", () => {
    expect(
      secretSnippet(
        "~/.open-artifacts/open-artifacts-staging-cloudflare-token",
        "Cloudflare deploy token",
      ),
    ).toBe(
      `bash -c 'set -e; umask 077; d="$HOME/.open-artifacts"; mkdir -p "$d"; chmod 700 "$d"; read -rsp "Cloudflare deploy token (hidden, then Enter): " T; echo; [ -n "$T" ] || { echo "nothing entered; not saved"; exit 1; }; rm -f "$d/open-artifacts-staging-cloudflare-token"; printf "%s" "$T" > "$d/open-artifacts-staging-cloudflare-token"; chmod 600 "$d/open-artifacts-staging-cloudflare-token"; echo "saved to $d/open-artifacts-staging-cloudflare-token"'`,
    );
  });

  it("secretRules: env var inside the command, or a given usage; no --token-file", () => {
    const file = secretFile("cloudflare");
    const env = secretRules({ file, envVar: SECRET_ENV_VARS.cloudflare });
    expect(env).toContain(
      `\`CLOUDFLARE_API_TOKEN="$(cat ${file})" pnpm --reporter=silent oa:setup …\``,
    );
    const usage = secretRules({ file, usage: "X=1 cmd" });
    expect(usage).toContain("`X=1 cmd`");
    expect(env + usage).not.toContain("--token-file");
  });
});

type Schema = {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  anyOf?: Schema[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
};

/** A tiny JSON Schema check: the keywords the vendored fragment uses. */
function valid(
  v: unknown,
  s: Schema,
  root: Schema & { $defs?: Record<string, Schema> },
): boolean {
  if (s.$ref) {
    const def = root.$defs?.[s.$ref.replace("#/$defs/", "")];
    return def ? valid(v, def, root) : false;
  }
  if (s.anyOf) return s.anyOf.some((a) => valid(v, a, root));
  if (s.enum && !s.enum.includes(v)) return false;
  const isObj = typeof v === "object" && v !== null && !Array.isArray(v);
  if (s.type === "object" && !isObj) return false;
  if (s.type === "string" && typeof v !== "string") return false;
  if (s.type === "boolean" && typeof v !== "boolean") return false;
  if (s.type === "integer" && !Number.isInteger(v)) return false;
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) return false;
    if (s.maximum !== undefined && v > s.maximum) return false;
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum)
      return false;
  }
  if (isObj) {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) return false;
    for (const [k, val] of Object.entries(o)) {
      const ps = s.properties?.[k];
      if (ps) {
        if (!valid(val, ps, root)) return false;
      } else if (s.additionalProperties === false) return false;
      else if (
        typeof s.additionalProperties === "object" &&
        !valid(val, s.additionalProperties, root)
      )
        return false;
    }
  }
  return true;
}

describe("agentClients", () => {
  const URL_ = "https://oa.example.com/mcp";
  const FILE = "~/.open-artifacts/oa-example-com-pat-token";
  const AGENTS = ["Claude Code", "Codex CLI", "Cursor", "OpenCode", "Generic"];

  it("dashboard form: 5 agents per variant, oauth first, each with verify and reload", () => {
    const all = agentClients(URL_);
    expect(all.map((s) => `${s.variant}:${s.agent}`)).toEqual([
      ...AGENTS.map((a) => `oauth:${a}`),
      ...AGENTS.map((a) => `token:${a}`),
    ]);
    for (const s of all) {
      expect(s.verify).toBeTruthy();
      expect(s.reload).toBeTruthy();
    }
    for (const s of all.filter((s) => s.variant === "token"))
      expect(s.code).toMatch(/OA_TOKEN|<YOUR_TOKEN>/);
  });

  it("file form: OAuth for every client first; Cursor has no token variant", () => {
    const all = agentClients(URL_, { tokenFile: FILE });
    expect(all.map((s) => `${s.variant}:${s.agent}`)).toEqual([
      ...AGENTS.map((a) => `oauth:${a}`),
      ...AGENTS.filter((a) => a !== "Cursor").map((a) => `token:${a}`),
    ]);
    for (const s of all) {
      expect(s.verify).toBeTruthy();
      expect(s.reload).toBeTruthy();
      expect(s.verify).not.toMatch(/\$\(cat|echo \$|printenv/);
    }
  });

  it("file form: each token variant reads the file at connect time, no env vars", () => {
    const tok = agentClients(URL_, { tokenFile: FILE }).filter(
      (s) => s.variant === "token",
    );
    for (const s of tok) {
      const text = `${s.code}\n${s.hint ?? ""}`;
      expect(text, s.agent).toContain(FILE);
      for (const bad of ["{env:", "${env:", "bearer_token_env_var", "OA_TOKEN"])
        expect(text, `${s.agent}: ${bad}`).not.toContain(bad);
      expect(s.code).not.toContain("oa_pat_");
    }
    const by = (a: string) => tok.find((s) => s.agent === a);
    expect(by("Claude Code")?.code).toBe(
      `claude mcp add-json -s user open-artifacts '{"type":"http","url":"${URL_}","headersHelper":"T=$(cat ${FILE}) && printf '\\''{\\"Authorization\\":\\"Bearer %s\\"}'\\'' \\"$T\\""}'`,
    );
    expect(by("Codex CLI")?.code).toBe(
      `[mcp_servers.open-artifacts]\nurl = "${URL_}"\nhttp_headers_helper = "T=$(cat ${FILE}) && printf '{\\"Authorization\\":\\"Bearer %s\\"}' \\"$T\\""`,
    );
    expect(by("OpenCode")?.code).toContain(`"Bearer {file:${FILE}}"`);
    expect(by("Generic")?.language).toBe("text");
    expect(by("Generic")?.code).not.toMatch(/<YOUR_TOKEN>|Bearer/);
  });

  it("file form: the saved helpers print the header, and fail without the file", () => {
    const home = mkdtempSync(join(tmpdir(), "oa-helper-"));
    const file = "~/.open-artifacts/x-pat-token";
    const tok = agentClients(URL_, { tokenFile: file });
    const claude = tok.find(
      (s) => s.agent === "Claude Code" && s.variant === "token",
    );
    const codex = tok.find(
      (s) => s.agent === "Codex CLI" && s.variant === "token",
    );
    // What Claude Code saves: the add-json argument, as the shell passes it.
    const saved = execFileSync("bash", [
      "-c",
      `claude() { printf '%s' "$6"; }; ${claude?.code}`,
    ]).toString();
    const helpers = [
      (JSON.parse(saved) as { headersHelper: string }).headersHelper,
      JSON.parse(
        /http_headers_helper = (".*")$/m.exec(codex?.code ?? "")?.[1] ?? '""',
      ) as string,
    ];
    const run = (h: string) =>
      spawnSync("bash", ["-c", h], {
        env: { HOME: home, PATH: process.env.PATH },
      });
    for (const h of helpers) {
      const missing = run(h);
      expect(missing.status, h).not.toBe(0);
      expect(missing.stdout.toString()).toBe("");
    }
    mkdirSync(join(home, ".open-artifacts"));
    writeFileSync(join(home, ".open-artifacts", "x-pat-token"), "oa_pat_abc");
    for (const h of helpers) {
      const ok = run(h);
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout.toString())).toEqual({
        Authorization: "Bearer oa_pat_abc",
      });
    }
  });

  it("file form: both OpenCode variants match OpenCode's McpRemoteConfig schema", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("./fixtures/opencode-mcp-remote.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const oc = agentClients(URL_, { tokenFile: FILE }).filter(
      (s) => s.agent === "OpenCode",
    );
    expect(oc).toHaveLength(2);
    for (const s of oc) {
      const entry = JSON.parse(s.code).mcp["open-artifacts"];
      expect(valid(entry, schema, schema), s.variant).toBe(true);
      expect(entry.enabled).toBeUndefined();
    }
    expect(valid({ type: "remote", url: "x", bogus: 1 }, schema, schema)).toBe(
      false,
    );
    expect(
      valid({ type: "remote", url: "x", oauth: true }, schema, schema),
    ).toBe(false);
  });
});
