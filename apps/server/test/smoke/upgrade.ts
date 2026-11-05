import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;

describe.skipIf(!base)("staging smoke: upgrade.md", () => {
  it("GET /upgrade.md is this instance's upgrade skill, at /healthz's version", async () => {
    const r = await fetch(`${base}/upgrade.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const md = await r.text();
    expect(md).toMatch(
      /^---\nname: open-artifacts-[a-z0-9]+(-[a-z0-9]+)*-upgrade\n/,
    );
    expect(md).toContain(`\`GET ${base}/healthz\``);
    expect(md).toMatch(
      /pnpm --reporter=silent oa:setup --upgrade --name [\w-]+ --json/,
    );
    expect(md).not.toContain("{{");
    const { version } = (await (await fetch(`${base}/healthz`)).json()) as {
      version: string;
    };
    expect(md).toContain(`  version: "${version}"\n`);
  });
});
