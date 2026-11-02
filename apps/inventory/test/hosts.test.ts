import {
  InventoryHostSchema,
  InventoryHostsSchema,
} from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
import { getJson, makeEnv, makeKv } from "./support.ts";

const ID = "iaaaaaaaaaaa";
const E = {
  "a.example.com": ID,
  "b.example.com": `paused:ibbbbbbbbbbb`,
  "c.example.com": `closed:iccccccccccc`,
  "d.example.com": "junk <script>",
  "e.example.com": "paused:",
  "f.example.com": `open:${ID}`,
  "g.example.com": "i000000admin",
  "h.example.com": "",
  "i.example.com": `paused:i00000signup`,
};
const withKv = (entries: Record<string, string>, page = 2) => {
  const k = makeKv(entries, page);
  return { ...k, env: makeEnv({ HOSTS: k.kv }) };
};

describe("GET /hosts", () => {
  it("every value through parseHostsValue: three modes, the rest null", async () => {
    const { env, calls } = withKv(E, 2);
    const body = await getJson(env, "/hosts");
    expect(InventoryHostsSchema.strict().safeParse(body).success).toBe(true);
    expect(body).toEqual({
      hosts: [
        { host: "a.example.com", installId: ID, mode: "serving" },
        { host: "b.example.com", installId: "ibbbbbbbbbbb", mode: "paused" },
        { host: "c.example.com", installId: "iccccccccccc", mode: "closed" },
        { host: "d.example.com", installId: null, mode: null },
        { host: "e.example.com", installId: null, mode: null },
        { host: "f.example.com", installId: null, mode: null },
        { host: "g.example.com", installId: null, mode: null },
        { host: "h.example.com", installId: null, mode: null },
        { host: "i.example.com", installId: null, mode: null },
      ],
      complete: true,
    });
    for (const h of body.hosts as object[])
      expect(InventoryHostSchema.strict().safeParse(h).success).toBe(true);
    expect(calls.list).toBe(5);
    expect(calls.writes).toBe(0);
    expect(JSON.stringify(body)).not.toContain("script");
  });

  it("an empty namespace is complete with no hosts", async () => {
    expect(await getJson(withKv({}).env, "/hosts")).toEqual({
      hosts: [],
      complete: true,
    });
  });

  it("stops at 10,000 keys with complete:false; exactly 10,000 is complete", async () => {
    for (const [n, complete] of [
      [10_001, false],
      [10_000, true],
    ] as const) {
      const big: Record<string, string> = {};
      for (let i = 0; i < n; i++)
        big[`h${String(i).padStart(5, "0")}.example.com`] = ID;
      const body = (await getJson(withKv(big, 1000).env, "/hosts")) as {
        hosts: unknown[];
        complete: boolean;
      };
      expect(body.complete).toBe(complete);
      expect(body.hosts).toHaveLength(10_000);
      expect(InventoryHostsSchema.strict().safeParse(body).success).toBe(true);
    }
  });
});

describe("GET /hosts?host=", () => {
  const one = async (host: string) => {
    const { env } = withKv(E);
    const body = await getJson(env, `/hosts?host=${encodeURIComponent(host)}`);
    expect(InventoryHostSchema.strict().safeParse(body).success).toBe(true);
    return body;
  };

  it("serving, paused and closed", async () => {
    expect(await one("a.example.com")).toEqual({
      host: "a.example.com",
      installId: ID,
      mode: "serving",
    });
    expect(await one("b.example.com")).toEqual({
      host: "b.example.com",
      installId: "ibbbbbbbbbbb",
      mode: "paused",
    });
    expect(await one("c.example.com")).toEqual({
      host: "c.example.com",
      installId: "iccccccccccc",
      mode: "closed",
    });
  });

  it("unparseable values, platform principals and a miss are null", async () => {
    for (const h of [
      "d.example.com",
      "e.example.com",
      "f.example.com",
      "g.example.com",
      "h.example.com",
      "i.example.com",
      "nope.example.com",
      "",
      "x".repeat(600),
    ])
      expect(await one(h)).toEqual({ host: h, installId: null, mode: null });
  });

  it("the key is exact: no case or trailing-dot normalization", async () => {
    for (const h of ["A.example.com", "a.example.com."])
      expect(await one(h)).toEqual({ host: h, installId: null, mode: null });
  });
});
