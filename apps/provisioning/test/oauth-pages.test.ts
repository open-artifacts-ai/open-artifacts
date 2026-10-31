import { describe, expect, it } from "vitest";
import {
  ago,
  BOUNCE_CSP,
  bouncePage,
  type Chrome,
  type ConsentView,
  connectedPage,
  consentPage,
  deniedPage,
  fill,
  messagePage,
  minutesLeft,
  PAGE_CSP,
  reauthPage,
  signinPage,
} from "../src/auth/oauth/pages.js";

// W13b: Design's admin-consent pages (design v7 9A.3.2, 4.5), rendered with
// every placeholder filled and every value escaped.

const STAGING: Chrome = { env: "staging", adminHost: "admin.example.test" };
const PROD: Chrome = { env: "prod", adminHost: "admin.example.test" };

const VIEW: ConsentView = {
  clientName: "Test agent",
  clientId: "cl_123",
  registeredSecondsAgo: 180,
  redirectHost: "127.0.0.1",
  loopback: true,
  adminEmail: "admin@example.test",
  switchUrl: "/auth/start?return=%2Foauth%2Fauthorize%3Fa%3D1",
  handle: "h_1",
  consentToken: "a".repeat(64),
};

const pages: [string, () => Response][] = [
  ["consent", () => consentPage(STAGING, VIEW, new Headers())],
  ["bounce", () => bouncePage(STAGING, "/oauth/authorize?a=1&b=1")],
  ["signin", () => signinPage(STAGING, "/auth/start?return=x")],
  [
    "reauth",
    () =>
      reauthPage(STAGING, {
        leftMs: 40 * 60_000,
        cancelUrl: "/",
        reauthUrl: "/auth/start?return=x",
      }),
  ],
  ["denied", () => deniedPage(STAGING)],
  ["connected", () => connectedPage(STAGING)],
  ["message", () => messagePage(STAGING, "Signed out", "Start again.", 401)],
];

describe("every page", () => {
  it.each(pages)("%s: filled, no script, no URL, headers set", async (_, f) => {
    const res = f();
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("{{");
    expect(html).not.toMatch(/\{\{\w+\}\}/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:/i);
    expect(html).not.toMatch(/@import|url\(/);
    expect(html).not.toContain("—");
    expect(html).toContain('<span class="env staging">Staging</span>');
    expect(html).toContain('<span class="mono">admin.example.test</span>');
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toMatch(/<title>[^<]+ · Open Artifacts admin<\/title>/);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("the consent page's CSP is the install's PAGE_CSP, with no form-action", () => {
    const csp = consentPage(STAGING, VIEW, new Headers()).headers.get(
      "content-security-policy",
    );
    expect(csp).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(csp).toBe(PAGE_CSP);
    expect(csp).not.toContain("form-action");
    expect(csp).not.toContain("script-src");
  });

  it("the bounce page's CSP allows no form and no script", () => {
    const csp = bouncePage(STAGING, "/x").headers.get(
      "content-security-policy",
    );
    expect(csp).toBe(BOUNCE_CSP);
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("script-src");
  });

  it("prod shows the Production badge and the production admin", async () => {
    const html = await consentPage(PROD, VIEW, new Headers()).text();
    expect(html).toContain('<span class="env prod">Production</span>');
    expect(html).toContain("the production admin?");
    const signin = await signinPage(PROD, "/s").text();
    expect(signin).toContain("connect to the production admin.");
  });
});

describe("consent page", () => {
  it("fills Design's facts", async () => {
    const html = await consentPage(STAGING, VIEW, new Headers()).text();
    expect(html).toContain('<input type="hidden" name="request" value="h_1">');
    expect(html).toContain(
      `<input type="hidden" name="consent_token" value="${"a".repeat(64)}">`,
    );
    expect(html).toContain('<b>Calls itself "Test agent"</b>');
    expect(html).toContain(
      'Client <span class="mono">cl_123</span> · registered 3 minutes ago · redirects to <span class="mono">127.0.0.1</span> (Local app)',
    );
    expect(html).toContain("Signed in as <b>admin@example.test</b>");
    expect(html).toContain(
      '<a href="/auth/start?return=%2Foauth%2Fauthorize%3Fa%3D1">Not you?</a>',
    );
    expect(html).toContain(
      "Access ends when your admin session does, within 8 hours.",
    );
  });

  it("a non-loopback redirect has no Local app note; an unknown date still renders", async () => {
    const html = await consentPage(
      STAGING,
      {
        ...VIEW,
        loopback: false,
        redirectHost: "claude.ai",
        registeredSecondsAgo: null,
      },
      new Headers(),
    ).text();
    expect(html).not.toContain("Local app");
    expect(html).toContain("registered at an unknown time");
  });

  it("pre-checks read and audit only; delete and pii sit apart", async () => {
    const html = await consentPage(STAGING, VIEW, new Headers()).text();
    const boxes = [
      ...html.matchAll(
        /<input type="checkbox" name="scope" value="([a-z:]+)"( checked)?>/g,
      ),
    ].map((m) => [m[1], m[2] === " checked"]);
    expect(boxes).toEqual([
      ["installs:read", true],
      ["audit:read", true],
      ["installs:write", false],
      ["installs:delete", false],
      ["installs:pii", false],
    ]);
    const [main, apart] = html.split('<ul class="sensitive">');
    expect(main).not.toContain("installs:delete");
    expect(main).not.toContain("installs:pii");
    expect(apart).toContain("Delete and restore installs");
    expect(apart).toContain("See owner emails");
  });

  it("escapes every interpolated value", async () => {
    const evil = `"><script>alert(1)</script><img src=x onerror='a()'>&`;
    const esc =
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&#39;a()&#39;&gt;&amp;";
    const html = await consentPage(
      { env: "staging", adminHost: evil },
      {
        clientName: evil,
        clientId: evil,
        registeredSecondsAgo: 0,
        redirectHost: evil,
        loopback: false,
        adminEmail: evil,
        switchUrl: evil,
        handle: evil,
        consentToken: evil,
      },
      new Headers(),
    ).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror='");
    // admin host, name, id, redirect host, email, switch link, handle, token.
    expect(html.split(esc).length - 1).toBe(8);
  });

  it("a hostile value is not expanded as a placeholder", async () => {
    const html = await consentPage(
      STAGING,
      { ...VIEW, clientName: "{{consent_token}}" },
      new Headers(),
    ).text();
    expect(html).toContain('Calls itself "{{consent_token}}"');
    expect(html.split("a".repeat(64)).length - 1).toBe(1);
  });
});

describe("the other pages", () => {
  it("bounce: a meta refresh and a Continue link to the same URL, escaped", async () => {
    const html = await bouncePage(STAGING, "/oauth/authorize?a=1&b=1").text();
    expect(html).toContain(
      '<meta http-equiv="refresh" content="0;url=/oauth/authorize?a=1&amp;b=1">',
    );
    expect(html).toContain(
      '<a class="button primary" href="/oauth/authorize?a=1&amp;b=1">Continue</a>',
    );
    expect(html).toContain("<h1>Continue to the admin panel</h1>");
    expect(html).not.toContain("<form");
  });

  it("bounce escapes its URL", async () => {
    const html = await bouncePage(STAGING, `/x?"><script>`).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("/x?&quot;&gt;&lt;script&gt;");
  });

  it("signin links Google sign-in", async () => {
    const html = await signinPage(STAGING, "/auth/start?return=x").text();
    expect(html).toContain("<h1>Sign in to continue</h1>");
    expect(html).toContain("connect to the staging admin.");
    expect(html).toContain(
      '<a class="button primary" href="/auth/start?return=x">Sign in with Google</a>',
    );
  });

  it("reauth names the time left and links cancel and sign in again", async () => {
    const html = await reauthPage(STAGING, {
      leftMs: 40 * 60_000 + 59_000,
      cancelUrl: "/",
      reauthUrl: "/auth/start?return=x",
    }).text();
    expect(html).toContain("<h1>Sign in again first</h1>");
    expect(html).toContain("Your admin session ends in 40 minutes,");
    expect(html).toContain('<a class="button" href="/">Cancel</a>');
    expect(html).toContain(
      '<a class="button primary" href="/auth/start?return=x">Sign in again</a>',
    );
  });

  it("denied and connected carry Design's copy", async () => {
    const denied = await deniedPage(STAGING).text();
    expect(denied).toContain("<h1>Not connected</h1>");
    expect(denied).toContain("You denied the agent. You can close this tab.");
    const ok = await connectedPage(STAGING).text();
    expect(ok).toContain("<h1>Connected</h1>");
    expect(ok).toContain(
      "Go back to your agent. Revoke it anytime in Agent tokens.",
    );
  });

  it("message pages escape their title and text and keep the status", async () => {
    const res = messagePage(STAGING, "<b>x</b>", "<i>y</i>", 409);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("<h1>&lt;b&gt;x&lt;/b&gt;</h1>");
    expect(html).toContain("<p>&lt;i&gt;y&lt;/i&gt;</p>");
  });
});

describe("helpers", () => {
  it("fill throws on a placeholder without a value", () => {
    expect(() => fill("{{a}} {{b}}", { a: "1" })).toThrow(/b has no value/);
    expect(fill("{{a}}", { a: "<" })).toBe("&lt;");
  });

  it("ago and minutesLeft", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(-5)).toBe("just now");
    expect(ago(60)).toBe("1 minute ago");
    expect(ago(180)).toBe("3 minutes ago");
    expect(ago(3600)).toBe("1 hour ago");
    expect(ago(3 * 86400)).toBe("3 days ago");
    expect(minutesLeft(40 * 60_000)).toBe("40 minutes");
    expect(minutesLeft(60_000)).toBe("1 minute");
    expect(minutesLeft(-1)).toBe("1 minute");
  });
});
