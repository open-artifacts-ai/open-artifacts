import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineLabelSchema } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import { login } from "../src/commands/login.ts";
import { browserCommand, openBrowser } from "../src/deps.ts";

const TOKEN = `oa_machine_${"a".repeat(32)}`;
const DEV = "d".repeat(43);
const URI = "https://bus.test/bus/approve";
const tmp = () => mkdtempSync(join(tmpdir(), "ob-adv-"));
const okCode = (over: Record<string, unknown> = {}) => ({
  device_code: DEV,
  user_code: "ABCD-2345",
  verification_uri: URI,
  expires_in: 600,
  interval: 5,
  ...over,
});
const approved = { status: "approved", machine_token: TOKEN };

/** Hub mock; throws after `cap` token polls so an infinite loop fails fast. */
const hub = (
  code: unknown,
  polls: (Response | Error | unknown)[],
  cap = 200,
) => {
  const urls: string[] = [];
  let n = 0;
  const fetch = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith("/bus/device")) return Response.json(code);
    if (++n > cap) throw new Error(`LOOP: >${cap} polls`);
    const p = polls.length > 1 ? polls.shift() : polls[0];
    if (p instanceof Error) throw p;
    if (p instanceof Response) return p;
    return Response.json(p);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls };
};

const args = (
  h: ReturnType<typeof hub>,
  over: Record<string, unknown> = {},
) => {
  let t = 0;
  return {
    hub: "https://bus.test",
    home: tmp(),
    label: "laptop",
    fetch: h.fetch,
    openBrowser: vi.fn(async () => true),
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    print: vi.fn(),
    now: () => t,
    ...over,
  };
};

describe("hardening: hostile device/code responses", () => {
  for (const uri of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://evil.example/bus/approve",
    "https://user:pw@bus.test/bus/approve",
    "https://bus.test@evil.example/bus/approve",
    "https://bus.test/elsewhere",
    "https://bus.test/bus/approve?next=https://evil.example",
    // RFC 8628 section 5.4: never a link that carries the code.
    "https://bus.test/bus/approve/ABCD-2345",
    "https://bus.test/bus/approve/WXYZ-2345",
    "https://bus.test/bus/approve?user_code=ABCD-2345",
    "https://bus.test/bus/approve#ABCD2345",
  ]) {
    it(`rejects verification_uri ${uri} before openBrowser`, async () => {
      const a = args(hub(okCode({ verification_uri: uri }), [approved]));
      await expect(login(a)).rejects.toThrow();
      expect(a.openBrowser).not.toHaveBeenCalled();
    });
  }

  it("rejects a user_code that is not XXXX-XXXX", async () => {
    const a = args(
      hub(okCode({ user_code: "\u001b]0;pwned\u0007" }), [approved]),
      {
        noOpen: true,
      },
    );
    await expect(login(a)).rejects.toThrow();
    expect(a.print.mock.calls.flat().join("")).not.toContain(
      String.fromCharCode(27),
    );
  });

  it("rejects a device_code that is not 43 base58 characters", async () => {
    for (const device_code of [
      "x",
      "0".repeat(43),
      "_".repeat(43),
      "d".repeat(44),
    ]) {
      const a = args(hub(okCode({ device_code }), [approved]));
      await expect(login(a)).rejects.toThrow();
      expect(a.sleep).not.toHaveBeenCalled();
    }
  });

  it("rejects expires_in and interval other than the F2.4 literals", async () => {
    for (const over of [{ expires_in: 1e308 }, { interval: 1e9 }]) {
      const a = args(hub(okCode(over), [approved]));
      await expect(login(a)).rejects.toThrow();
      expect(a.sleep).not.toHaveBeenCalled();
    }
  });

  it("always prints the URL and user code, even when the browser opened", async () => {
    const a = args(hub(okCode(), [approved]));
    await login(a);
    const out = a.print.mock.calls.flat().join("\n");
    expect(out).toContain(URI);
    expect(out).toContain("ABCD-2345");
  });

  it("opens the plain approval page: the code is never in the URL", async () => {
    const a = args(hub(okCode(), [approved]));
    await login(a);
    expect(a.openBrowser).toHaveBeenCalledWith("https://bus.test/bus/approve");
    for (const u of a.openBrowser.mock.calls.flat() as unknown[]) {
      expect(String(u)).not.toContain("ABCD");
      expect(String(u)).not.toContain("2345");
    }
  });

  it("accepts http only for loopback hubs", async () => {
    const ok = args(
      hub(
        okCode({
          verification_uri: "http://localhost:8787/bus/approve",
        }),
        [approved],
      ),
      { hub: "http://localhost:8787" },
    );
    await expect(login(ok)).resolves.toBeDefined();
    const bad = args(
      hub(okCode({ verification_uri: "http://bus.test/bus/approve" }), [
        approved,
      ]),
      { hub: "http://bus.test" },
    );
    await expect(login(bad)).rejects.toThrow();
  });

  it("device/code non-2xx is a clear error", async () => {
    const a = args(hub(okCode(), [approved]), {
      fetch: vi.fn(async () => new Response("nope", { status: 503 })),
    });
    await expect(login(a)).rejects.toThrow(/bus\/device failed: 503/);
  });
});

describe("hardening: polling", () => {
  it("survives one transient network error mid-poll", async () => {
    const a = args(
      hub(okCode(), [
        { status: "pending" },
        new TypeError("fetch failed"),
        approved,
      ]),
    );
    await expect(login(a)).resolves.toMatchObject({ machineToken: TOKEN });
  });

  it("backs off on HTTP 429 instead of aborting", async () => {
    const a = args(
      hub(okCode(), [new Response("slow down", { status: 429 }), approved]),
    );
    await expect(login(a)).resolves.toMatchObject({ machineToken: TOKEN });
  });

  it("5xx is retried; other 4xx is fatal", async () => {
    const a = args(
      hub(okCode(), [new Response("x", { status: 502 }), approved]),
    );
    await expect(login(a)).resolves.toMatchObject({ machineToken: TOKEN });
    const b = args(hub(okCode(), [new Response("x", { status: 400 })]));
    await expect(login(b)).rejects.toThrow(/400/);
  });

  it("429 doubles the wait up to 30s", async () => {
    const a = args(
      hub(okCode(), [
        ...Array(6).fill(new Response("x", { status: 429 })),
        approved,
      ]),
    );
    await login(a);
    const waits = a.sleep.mock.calls.map((c) => c[0] as number);
    expect(waits[1]).toBe(10_000);
    expect(Math.max(...waits)).toBe(30_000);
  });

  it("a clock going backwards does not extend the deadline forever", async () => {
    let t = 0;
    const a = args(hub(okCode(), [{ status: "pending" }], 1000), {
      now: () => (t -= 1000),
    });
    await expect(login(a)).rejects.toThrow(/expired|timed out/);
  });
});

describe("hardening: hub URL", () => {
  it("trailing slash does not produce //bus/device", async () => {
    const h = hub(okCode(), [approved]);
    await login(args(h, { hub: "https://bus.test/" }));
    expect(
      h.urls.every((u) => !u.slice("https://".length).includes("//")),
    ).toBe(true);
  });
});

describe("hardening: machine.json on disk", () => {
  it("stores the hub without a trailing slash", async () => {
    const a = args(hub(okCode(), [approved]), { hub: "https://bus.test/" });
    const r = await login(a);
    expect(r.hub).toBe("https://bus.test");
    expect(
      JSON.parse(readFileSync(join(r.home, "machine.json"), "utf8")).hub,
    ).toBe("https://bus.test");
  });

  it("does not follow a symlink at machine.json and clobber its target", async () => {
    const home = tmp();
    const victim = join(tmp(), "victim");
    writeFileSync(victim, "precious\n", { mode: 0o644 });
    symlinkSync(victim, join(home, "machine.json"));
    await login(args(hub(okCode(), [approved]), { home })).catch(() => {});
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(statSync(victim).mode & 0o777).toBe(0o644);
  });

  it("tightens a pre-existing 0755 home dir to 0700", async () => {
    const home = join(tmp(), "h");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    await login(args(hub(okCode(), [approved]), { home }));
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });
});

describe("hardening: token never leaks", () => {
  it("malformed approved token is not echoed in the error", async () => {
    const bad = `oa_machine_${"a".repeat(31)}`;
    const a = args(hub(okCode(), [{ ...approved, token: bad }]));
    const err = await login(a).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(bad);
  });
});

describe("hardening: machine label", () => {
  it("sends a label that passes MachineLabelSchema for a hostile hostname", async () => {
    const urls: unknown[] = [];
    const h = hub(okCode(), [approved]);
    const fetch = vi.fn(
      async (u: string | URL | Request, init?: RequestInit) => {
        if (String(u).endsWith("/bus/device"))
          urls.push(JSON.parse(String(init?.body)));
        return h.fetch(u, init);
      },
    );
    const r = await login(
      args(h, {
        fetch,
        label: ` lap\u202Etop\u200B\u0000${"😀".repeat(200)} `,
      }),
    );
    expect(MachineLabelSchema.safeParse(r.label).success).toBe(true);
    expect(urls[0]).toEqual({ machine_label: r.label });
  });
});

describe("hardening: browser launcher", () => {
  it("never goes through cmd on win32", () => {
    expect(browserCommand("win32", "https://x/y&calc.exe")).toEqual({
      cmd: "rundll32",
      args: ["url.dll,FileProtocolHandler", "https://x/y&calc.exe"],
    });
    expect(browserCommand("darwin", "u").cmd).toBe("open");
    expect(browserCommand("linux", "u").cmd).toBe("xdg-open");
  });

  it("resolves false when the launcher is missing", async () => {
    expect(
      await openBrowser("https://x", { cmd: "ob-no-such-launcher", args: [] }),
    ).toBe(false);
  });

  it("resolves true when it spawns", async () => {
    expect(
      await openBrowser("https://x", {
        cmd: process.execPath,
        args: ["-e", "0"],
      }),
    ).toBe(true);
  });
});
