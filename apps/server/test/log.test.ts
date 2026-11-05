// Server logs are readable account-wide on hosted installs: redact strips
// URLs, emails, tokens and signed paths, and no new unstructured console call
// may slip into src.
import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, redact } from "../src/log.js";

describe("redact", () => {
  it("keeps only the host of a URL", () => {
    expect(redact("fetch https://c.example.com/c/abc/def?sig=xyz failed")).toBe(
      "fetch <url:c.example.com> failed",
    );
    expect(redact("ws://u:p@h.test:8787/x")).toBe("<url:h.test:8787>");
  });
  it("hides emails", () => {
    expect(redact("no user me@example.com here")).toBe("no user <email> here");
  });
  it("hides bearer tokens, JWTs and long base64url / hex runs", () => {
    expect(redact("Authorization: Bearer abc.def")).toBe(
      "Authorization: Bearer <token>",
    );
    expect(redact("jwt eyJhbGciOi.eyJzdWIiOjF9.c2ln end")).toBe(
      "jwt <token> end",
    );
    expect(redact(`k=${"a1b2".repeat(8)}`)).toBe("k=<token>");
    expect(redact(`t ${"Ab_-".repeat(6)}`)).toBe("t <token>");
  });
  it("hides signed content and page paths", () => {
    expect(redact("GET /c/abc123/v1/index.html 404")).toBe("GET <path> 404");
    expect(redact("at /p/xyz")).toBe("at <path>");
  });
  it("keeps the runtime's support reference, and only that", () => {
    const id = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4";
    expect(redact(`internal error; reference = ${id}`)).toBe(
      `internal error; reference = ${id}`,
    );
    // Anything else in the same message is still redacted.
    expect(
      redact(
        `internal error; reference = ${id} at https://x.test/c/secret?t=1 for a@b.test`,
      ),
    ).toBe(`internal error; reference = ${id} at <url:x.test> for <email>`);
    // A long run elsewhere is still a token; an odd reference shape is not kept.
    expect(redact(`reference = ${id}`)).toBe("reference = <token>");
    expect(
      redact("internal error; reference = Bearer_ABCDEFGHIJKLMNOPQRSTUVWX"),
    ).toBe("internal error; reference = <token>");
  });

  it("leaves ids, enums and plain text alone", () => {
    for (const s of [
      "LxTbjr9wyc6M8o1Y",
      "quota_exceeded",
      "thumbnail_launch_failed",
      "D1_ERROR: no such table: artifacts",
      "Unable to connect: code: 429",
    ])
      expect(redact(s)).toBe(s);
  });
});

describe("logError", () => {
  afterEach(() => vi.restoreAllMocks());
  it("logs JSON with a redacted, capped message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError(
      "x_failed",
      new TypeError(`bad https://h.test/c/s ${"y ".repeat(400)}`),
      { artifactId: "abc" },
    );
    const out = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(out).toMatchObject({
      evt: "x_failed",
      name: "TypeError",
      artifactId: "abc",
    });
    expect(out.message.startsWith("bad <url:h.test> ")).toBe(true);
    expect(out.message.length).toBeLessThanOrEqual(300);
  });
});

// Every console call in src outside log.ts must be structured
// (`console.x(JSON.stringify({ evt: ...`) or allowlisted here. Prefer log.ts.
const ALLOW = [
  /^console\.warn\(\s*`EMBED_ORIGINS: dropped/, // config, not user data
  /^console\.warn\(\s*"EMBED_ORIGINS: dropped/, // config
  /^console\.warn\("PUBLIC_HOME ignored/, // config
  /^console\.warn\(`PUBLIC_HOME \$\{id\} ignored/, // config (an artifact id)
];
const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("log lint", () => {
  it("finds the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });
  it("has no unstructured console calls outside log.ts", () => {
    const bad: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      if (file.endsWith("/src/log.ts")) continue;
      for (const m of src.matchAll(/console\.(log|warn|error|info)\(/g)) {
        const call = src.slice(m.index, m.index + 200);
        const flat = call.replace(/\s+/g, " ").replace(/\( /g, "(");
        const structured = /^console\.\w+\(JSON\.stringify\(\{ ?evt:/.test(
          flat,
        );
        if (!structured && !ALLOW.some((re) => re.test(call)))
          bad.push(`${file}: ${flat.slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
