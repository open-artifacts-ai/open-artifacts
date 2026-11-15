import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  attestationsUrl,
  type FetchLike,
  fetchRelease,
  tarballUrl,
} from "../src/update/fetch.ts";

const body = (
  data: Buffer | string,
  status = 200,
  headers: Record<string, string> = {},
): Response => new Response(Buffer.from(data), { status, headers });
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "other";
  }
  return "none";
};

function fake(routes: (url: string) => Response | Promise<Response>): {
  f: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    f: async (url) => {
      urls.push(url);
      return routes(url);
    },
  };
}

describe("update fetch", () => {
  it("builds both URLs from the fixed name and version", () => {
    expect(tarballUrl("1.2.3")).toBe(
      "https://registry.npmjs.org/@open-artifacts/bus/-/bus-1.2.3.tgz",
    );
    expect(attestationsUrl("1.2.3")).toBe(
      "https://registry.npmjs.org/-/npm/v1/attestations/%40open-artifacts%2Fbus@1.2.3",
    );
  });

  it.each([
    "1.2",
    "1.2.3-x",
    "01.2.3",
    "1.2.3 ",
    "١.٢.٣",
    "../1.2.3",
    "1.2.3/../x",
  ])("refuses version %j before any request", async (v) => {
    const { f, urls } = fake(() => body("{}"));
    expect(await codeOf(fetchRelease(v, f))).toBe("bad_version");
    expect(urls).toEqual([]);
  });

  it("makes exactly two GETs and hashes the tarball while streaming", async () => {
    const tgz = Buffer.from("tarball bytes");
    const { f, urls } = fake((u) =>
      u.includes("attestations") ? body('{"attestations":[]}') : body(tgz),
    );
    const r = await fetchRelease("1.2.3", f);
    expect(urls).toEqual([attestationsUrl("1.2.3"), tarballUrl("1.2.3")]);
    expect(r.sha512).toBe(createHash("sha512").update(tgz).digest("hex"));
    expect(r.tarball.equals(tgz)).toBe(true);
  });

  it("treats a 404 on the attestations as no attestation, not as fetch error", async () => {
    const { f } = fake(() => body("nope", 404));
    expect(await codeOf(fetchRelease("1.2.3", f))).toBe("no_attestation");
  });

  it("refuses attestations that are not JSON", async () => {
    const { f } = fake(() => body("<html>"));
    expect(await codeOf(fetchRelease("1.2.3", f))).toBe("no_attestation");
  });

  it("follows a same-host redirect and refuses a cross-host one", async () => {
    const ok = fake((u) =>
      u.includes("attestations")
        ? body("{}")
        : u.endsWith("/moved.tgz")
          ? body("x")
          : body("", 302, { location: "https://registry.npmjs.org/moved.tgz" }),
    );
    expect((await fetchRelease("1.2.3", ok.f)).tarball.toString()).toBe("x");
    for (const loc of [
      "https://evil.example/bus.tgz",
      "http://registry.npmjs.org/bus.tgz",
      "https://registry.npmjs.org.evil.example/bus.tgz",
      "https://user:pw@registry.npmjs.org/bus.tgz",
      "https://registry.npmjs.org:8443/bus.tgz",
    ]) {
      const bad = fake((u) =>
        u.includes("attestations")
          ? body("{}")
          : body("", 302, { location: loc }),
      );
      expect(await codeOf(fetchRelease("1.2.3", bad.f)), loc).toBe(
        "bad_redirect",
      );
      expect(bad.urls.some((u) => u.startsWith("https://evil"))).toBe(false);
    }
  });

  it("refuses a redirect loop", async () => {
    const { f } = fake(() =>
      body("", 302, { location: "https://registry.npmjs.org/again" }),
    );
    expect(await codeOf(fetchRelease("1.2.3", f))).toBe("bad_redirect");
  });

  it("caps the body, by declared length and by what is streamed", async () => {
    const declared = fake((u) =>
      u.includes("attestations")
        ? body("{}")
        : body("x", 200, { "content-length": String(50 * 1024 * 1024) }),
    );
    expect(await codeOf(fetchRelease("1.2.3", declared.f))).toBe("too_large");
    const streamed = fake((u) =>
      u.includes("attestations")
        ? body("{}")
        : new Response(
            new ReadableStream({
              pull(c) {
                c.enqueue(new Uint8Array(1024 * 1024));
              },
            }),
          ),
    );
    expect(await codeOf(fetchRelease("1.2.3", streamed.f))).toBe("too_large");
    const att = fake(() => body(Buffer.alloc(2 * 1024 * 1024, 32)));
    expect(await codeOf(fetchRelease("1.2.3", att.f))).toBe("too_large");
  });

  it("maps network errors and HTTP errors to fetch_failed, and sets a timeout signal", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await codeOf(fetchRelease("1.2.3", boom))).toBe("fetch_failed");
    const five = fake(() => body("x", 503));
    expect(await codeOf(fetchRelease("1.2.3", five.f))).toBe("fetch_failed");
    let signal: AbortSignal | undefined | null;
    await fetchRelease("1.2.3", async (_u, init) => {
      signal = init.signal;
      return body("{}");
    });
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });
});
