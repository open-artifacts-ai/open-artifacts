// The bus confirm pages in a real browser (#1426): the link's secret is in
// the URL fragment, so the page script is what reads it, posts it in a body,
// and keeps it across the sign-in. A failure in that script would break every
// confirm, which the server tests can't see.
import {
  approveMachine,
  freshSignInUrl,
  openAgent,
  proposeLink,
  proposeReach,
  proposeRole,
} from "./bus-confirm";
import { APP, expect, freshEmail, loginAs, test, uniq } from "./fixtures";

const KINDS = [
  {
    kind: "roles",
    base: "/bus/roles/confirm",
    heading: "Create this role?",
    done: "Role updated",
  },
  {
    kind: "links",
    base: "/bus/links/confirm",
    heading: /Link .* and .*\?/,
    done: "Linked",
  },
  {
    kind: "reach",
    base: "/bus/reach/confirm",
    heading: /Let .* reach other projects\?/,
    done: "Reach updated",
  },
] as const;

for (const k of KINDS) {
  test(`${k.kind}: open the fragment link logged out, log in, confirm; the secret stays out of every request`, async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(120_000);
    const email = freshEmail(`${k.kind}-${info.project.name}`);
    await loginAs(page, email, "member");
    const machine = await approveMachine(page);
    const ns = `e2e.local/${uniq()}`;
    const agent = await openAgent(machine, ns);
    const target = `e2e.local/${uniq()}`;
    let url: string;
    if (k.kind === "roles") {
      url = await proposeRole(page, ns, agent.name, "e2e-lead");
    } else if (k.kind === "reach") {
      // A reach proposal needs a role the agent holds: make one first, the
      // way the member would, then ask as the daemon does (#1346).
      const roleUrl = await proposeRole(page, ns, agent.name, "e2e-lead");
      await page.goto(freshSignInUrl(email, "/"));
      await page.goto(roleUrl);
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Role updated" }),
      ).toBeVisible();
      url = await proposeReach(machine, agent.ref, [target]);
    } else {
      url = await proposeLink(machine, ns, `e2e.local/${uniq()}`);
    }
    const secret = new URL(url).hash.slice(1);
    expect(url).toBe(`${APP}${k.base}#${secret}`);

    // A browser with no session, as the person who got the link.
    const ctx = await browser.newContext();
    const requested: string[] = [];
    const consoleProblems: string[] = [];
    ctx.on("request", (r) => requested.push(r.url().split("#")[0] as string));
    ctx.on("console", (m) => {
      if (m.type() === "error") consoleProblems.push(m.text());
    });
    await ctx.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as unknown as { __csp: string[] }).__csp.push(
          e.violatedDirective,
        ),
      );
    });

    const p = await ctx.newPage();

    // The IdP is a reserved host: refuse the request at once, so the
    // browser doesn't sit on a DNS lookup (WebKit in CI did, and the next
    // navigation waited behind it). The redirect to it is all this needs.
    await ctx.route(/access\.e2e\.invalid/, (r) => r.abort());
    await p.goto(url, { timeout: 15_000 }).catch(() => {});
    // The hop keeps the secret in this tab and sends the browser to sign-in
    // without it: `next` is the page's path.
    await expect
      .poll(() => requested.some((u) => u.includes("access.e2e.invalid")))
      .toBe(true);
    expect(p.url()).not.toContain(secret);
    const login = requested.find((u) => u.includes("/auth/login"));
    expect(login, requested.join("\n")).toBeTruthy();
    expect(new URL(login as string).searchParams.get("next")).toBe(k.base);

    // Sign in (a fresh interactive session in dev), back to the page's path.
    // The card appearing is the proof the secret survived in sessionStorage.
    await p.goto(freshSignInUrl(email, k.base), { timeout: 15_000 });
    await expect(p.getByRole("heading", { name: k.heading })).toBeVisible();
    expect(await p.evaluate(() => location.hash)).toBe("");
    expect(p.url()).not.toContain(secret);

    await p.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(p.getByRole("heading", { name: k.done })).toBeVisible();
    expect(await p.evaluate(() => sessionStorage.length)).toBe(0);

    // It applied.
    const listed = await page.request.get(`${APP}/api/v1/bus/${k.kind}`);
    const body = await listed.text();
    expect(listed.ok(), body).toBe(true);
    expect(body).toContain(
      k.kind === "roles" ? "e2e-lead" : k.kind === "reach" ? target : ns,
    );

    // The same link again is refused, and an unknown one is a 404; neither
    // leaves a secret in the tab.
    // Opened from the link in a new tab (a fragment-only change in the same
    // tab never reloads the page).
    const spent = await ctx.newPage();
    await spent.goto(url);
    await expect(
      spent.getByRole("heading", { name: "Already decided" }),
    ).toBeVisible();
    expect(await spent.evaluate(() => sessionStorage.length)).toBe(0);
    const unknown = await ctx.newPage();
    await unknown.goto(`${APP}${k.base}#${"A".repeat(43)}`);
    await expect(
      unknown.getByRole("heading", { name: "This link doesn't work" }),
    ).toBeVisible();
    expect(await unknown.evaluate(() => sessionStorage.length)).toBe(0);
    expect(await unknown.evaluate(() => location.hash)).toBe("");

    for (const u of requested) expect(u, u).not.toContain(secret);
    expect(requested.some((u) => u.endsWith(`${k.base}/view`))).toBe(true);
    for (const q of [p, spent, unknown])
      expect(
        await q.evaluate(
          () => (window as unknown as { __csp: string[] }).__csp,
        ),
      ).toEqual([]);
    expect(
      consoleProblems.filter((m) => /Content Security Policy|CSP/i.test(m)),
    ).toEqual([]);
    agent.close();
    await ctx.close();
  });
}
