import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  checkFormCsrf,
  formCsrf,
  html,
  messagePage,
  PAGE_CSP,
  pageResponse,
  SafeHtml,
} from "../src/http/pages.js";

describe("http/pages html tag", () => {
  it("escapes every interpolated string", () => {
    const label = '"><script>alert(1)</script>';
    expect(String(html`<b title="${label}">${label}</b>`)).toBe(
      '<b title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</b>',
    );
  });

  it("keeps a nested html result as markup and still escapes a string inside it", () => {
    const rows = ["<i>a</i>", "b&c"].map((s) => html`<li>${s}</li>`);
    const out = String(html`<ul>${rows}</ul>`);
    expect(out).toBe("<ul><li>&lt;i&gt;a&lt;/i&gt;</li><li>b&amp;c</li></ul>");
  });

  it("has no raw slot: a SafeHtml-shaped plain object is escaped", () => {
    const fake = { value: "<script>" } as unknown as SafeHtml;
    expect(String(html`${fake}`)).toBe("[object Object]");
    expect(String(html`${new SafeHtml("<p>")}`)).toBe("<p>");
  });

  it("drops null, undefined and false; prints numbers", () => {
    expect(String(html`${null}${undefined}${false}${0}`)).toBe("0");
  });
});

describe("http/pages responses", () => {
  it("pageResponse sets the page CSP, no-store and DENY", () => {
    const r = pageResponse("<p>x</p>", 200);
    expect(r.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("messagePage escapes title and message", async () => {
    const r = messagePage("<t>", "<m>", 403);
    expect(r.status).toBe(403);
    const body = await r.text();
    expect(body).toContain("&lt;t&gt;");
    expect(body).toContain("<p>&lt;m&gt;</p>");
    expect(body).not.toContain("<m>");
  });
});

describe("http/pages form CSRF", () => {
  it("round trips for the same scope, user and handle only", async () => {
    const t = await formCsrf(env, "s1", "u1", "h1");
    expect(await checkFormCsrf(env, "s1", "u1", "h1", t)).toBe(true);
    expect(await checkFormCsrf(env, "s2", "u1", "h1", t)).toBe(false);
    expect(await checkFormCsrf(env, "s1", "u2", "h1", t)).toBe(false);
    expect(await checkFormCsrf(env, "s1", "u1", "h2", t)).toBe(false);
    expect(await checkFormCsrf(env, "s1", "u1", "h1", "nope")).toBe(false);
  });

  it("refuses an expired token", async () => {
    const t = await formCsrf(env, "s", "u", "h");
    const past = `${Math.floor(Date.now() / 1000) - 1}${t.slice(t.indexOf("."))}`;
    expect(await checkFormCsrf(env, "s", "u", "h", past)).toBe(false);
  });
});
