import { describe, expect, it } from "vitest";
import inviteHtml from "../../../design/emails/invite.html?raw";
import inviteTxt from "../../../design/emails/invite.txt?raw";
import shareHtml from "../../../design/emails/share.html?raw";
import shareTxt from "../../../design/emails/share.txt?raw";
import {
  INVITE_HTML,
  INVITE_TXT,
  SHARE_HTML,
  SHARE_TXT,
} from "../src/email/email-templates.js";
import {
  fill,
  introLine,
  inviteEmail,
  senderName,
  shareEmail,
  signInSentence,
} from "../src/email/templates.js";

const EVIL = '"><script>alert(1)</script>\r\nBcc: evil@x.com {{logoUrl}} &amp;';
const common = {
  inviter: `Mal${EVIL}`,
  instance: `Acme${EVIL}`,
  recipient: "new@x.com",
  appHost: "app.example.com",
  signIn: ["email"] as ("access" | "google" | "email")[],
};

/** Asserts a rendered email is clean, whatever the input. */
function clean(m: { subject: string; text: string; html: string }) {
  expect(m.subject).not.toMatch(/[\r\n]/);
  expect(m.subject.length).toBeLessThanOrEqual(150);
  for (const part of [m.subject, m.text, m.html]) {
    expect(part).not.toContain("\r");
    expect(part).not.toMatch(/\nBcc/);
  }
  expect(m.html).not.toContain("<script>");
  expect(m.html).toContain("&lt;script&gt;");
  // A placeholder inside a value is data, not a second substitution.
  expect(m.html).toContain("{{logoUrl}}");
  expect(m.html).toContain("&amp;amp;");
  expect(m.html).toContain('src="https://app.example.com/email/logo@2x.png"');
  for (const href of m.html.matchAll(/href="([^"]*)"/g))
    expect(href[1]).toMatch(/^https:\/\/app\.example\.com\//);
}

describe("email templates", () => {
  it("the bundled templates match design/emails (run the build)", () => {
    expect(INVITE_HTML).toBe(inviteHtml);
    expect(INVITE_TXT).toBe(inviteTxt);
    expect(SHARE_HTML).toBe(shareHtml);
    expect(SHARE_TXT).toBe(shareTxt);
  });

  it("renders the invite with hostile values", () => {
    const m = inviteEmail(common);
    clean(m);
    expect(m.text).toContain("https://app.example.com/sign-in");
    expect(m.html).toContain('href="https://app.example.com/sign-in"');
    expect(m.text).toContain("new@x.com");
  });

  it("renders the share with hostile values", () => {
    const m = shareEmail({
      ...common,
      title: `Plan${EVIL}<img src=x onerror=1>`,
      path: "/a/abc",
      format: "markdown",
      role: "editor",
    });
    clean(m);
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain('href="https://app.example.com/a/abc"');
    expect(m.text).toContain("Format: Markdown doc");
    expect(m.text).toContain("Your role: Editor");
    expect(m.subject).toMatch(/^Mal.* shared “Plan/);
  });

  it("refuses links off the app host", () => {
    for (const appHost of ["x.com/@evil", "evil.com:80@x", "a b"])
      expect(() => inviteEmail({ ...common, appHost })).toThrow();
    for (const path of ["@evil.com/x", ".evil.com/x", "x"])
      expect(() =>
        shareEmail({
          ...common,
          title: "t",
          path,
          format: "pdf",
          role: "viewer",
        }),
      ).toThrow();
  });

  it("fill throws on an unknown, unfilled or malformed placeholder", () => {
    expect(() => fill("Hi {{who}}", {})).toThrow(/who/);
    expect(() => fill("Hi {{ who }}", { who: "x" })).toThrow(/malformed/);
    expect(() => fill("Hi {{who-1}}", { who: "x" })).toThrow(/malformed/);
    expect(fill("Hi {{who}}", { who: "<b>" }, (s) => `[${s}]`)).toBe(
      "Hi [<b>]",
    );
  });
});

describe("copy (#213)", () => {
  const OWN =
    "Open Artifacts is a place where any AI agent publishes pages, docs, code and PDFs for your team.";
  it("introLine names a custom instance, and never repeats the product", () => {
    expect(introLine("Acme Docs")).toBe(
      "Acme Docs runs Open Artifacts, a place where any AI agent publishes pages, docs, code and PDFs for your team.",
    );
    for (const n of ["Open Artifacts", "  open artifacts ", "OPEN ARTIFACTS"])
      expect(introLine(n)).toBe(OWN);
  });

  const render = (instance: string) => [
    inviteEmail({ ...common, inviter: "Ada", instance }),
    shareEmail({
      ...common,
      inviter: "Ada",
      instance,
      title: "Plan",
      path: "/a/abc",
      format: "markdown",
      role: "viewer",
    }),
  ];

  it("no email says 'Open Open' or 'Open Artifacts runs Open Artifacts'", () => {
    for (const instance of ["Open Artifacts", " open artifacts", "Acme"])
      for (const m of render(instance))
        for (const part of [m.subject, m.text, m.html]) {
          expect(part).not.toMatch(/Open Open/i);
          expect(part).not.toMatch(/Open Artifacts runs Open Artifacts/i);
        }
  });

  it("the invite intro uses introLine, HTML-escaped", () => {
    const [inv] = render("A&B <Docs>");
    expect(inv?.text).toContain(introLine("A&B <Docs>"));
    expect(inv?.html).toContain(
      "A&amp;B &lt;Docs&gt; runs Open Artifacts, a place where",
    );
    const [own] = render("Open Artifacts");
    expect(own?.text).toContain(OWN);
    expect(own?.html).toContain(OWN);
  });

  it("a user named 'me' (the sign-in default) is shown as the full address", () => {
    const inviter = senderName({ name: "me", email: "me@leourbina.com" });
    const m = inviteEmail({ ...common, inviter, instance: "Open Artifacts" });
    expect(m.subject).toBe("me@leourbina.com added you to Open Artifacts");
  });
});

// Review item 11: the sign-in copy names only the methods that admit the
// recipient; never "a one-time code" when codes aren't offered to them.
describe("sign-in copy (review item 11)", () => {
  const share = (signIn: typeof common.signIn) =>
    shareEmail({
      ...common,
      inviter: "Ada",
      instance: "Acme",
      title: "Plan",
      path: "/a/abc",
      format: "pdf",
      role: "viewer",
      signIn,
    });
  const invite = (signIn: typeof common.signIn) =>
    inviteEmail({ ...common, inviter: "Ada", instance: "Acme", signIn });

  it.each([
    [["email"], "You'll sign in with a one-time code sent to new@x.com."],
    [["google"], "You'll sign in with your Google account."],
    [["access"], "You'll sign in with your organization's single sign-on."],
    [
      ["email", "google"],
      "You'll sign in with your Google account or a one-time code sent to new@x.com.",
    ],
  ] as const)("%j: %s", (signIn, line) => {
    const inv = invite([...signIn]);
    for (const part of [inv.text, inv.html.replaceAll("&#39;", "'")])
      expect(part).toContain(`There's no password to set up. ${line}`);
    const sh = share([...signIn]);
    for (const part of [sh.text, sh.html.replaceAll("&#39;", "'")])
      expect(part).toContain(line);
    if (!(signIn as readonly string[]).includes("email"))
      for (const m of [inv, sh])
        for (const part of [m.subject, m.text, m.html])
          expect(part).not.toContain("one-time code");
  });

  it("the invite preheader follows the methods too", () => {
    const pre = (signIn: typeof common.signIn) =>
      invite(signIn).html.replaceAll("&#39;", "'");
    expect(pre(["google"])).toContain(
      ">You'll sign in with your Google account.&#8199;",
    );
    expect(pre(["email"])).toContain(
      ">You'll sign in with a one-time code sent to this address.&#8199;",
    );
  });

  it("no method: says they need an invite, promises nothing", () => {
    expect(
      signInSentence([], "x@y.com", { instance: "Acme", inviter: "Ada" }),
    ).toBe(
      "You can't sign in to Acme yet. Ask Ada to invite you as a member first.",
    );
    const m = share([]);
    expect(m.text).toContain("You can't sign in to Acme yet.");
    for (const part of [m.text, m.html]) {
      expect(part).not.toContain("one-time code");
      expect(part).not.toContain("sign in with");
    }
  });

  it("no em dashes in the sign-in copy", () => {
    for (const signIn of [
      [],
      ["email"],
      ["google", "access", "email"],
    ] as const)
      for (const m of [invite([...signIn]), share([...signIn])])
        for (const part of [m.subject, m.text, m.html])
          expect(part).not.toContain("\u2014");
  });
});
