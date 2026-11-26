// The bus confirm pages in a real browser (#1426): the link's secret is in
// the URL fragment, so the page script is what reads it, posts it in a body,
// and keeps it across the sign-in. A failure in that script would break every
// confirm, which the server tests can't see.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import {
  approveMachine,
  freshSignInUrl,
  openAgent,
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
] as const;

/**
 * Holds the approve POST's BODY until `release()`, after the browser has its
 * status and headers: the request goes to a tiny local server that asks the
 * real one, writes status and headers (flushed), and ends the body only when
 * the test lets it. `reached` resolves once the headers are out.
 */
async function holdApproveBody(page: Page) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reached: () => void = () => {};
  const headersOut = new Promise<void>((r) => {
    reached = r;
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const headers: Record<string, string> = {};
      for (const k of ["content-type", "x-oa-request", "accept"])
        if (typeof req.headers[k] === "string")
          headers[k] = req.headers[k] as string;
      const cookie = req.headers["x-forward-cookie"];
      if (typeof cookie === "string") headers.cookie = cookie;
      const up = await fetch(`${APP}/bus/approve`, {
        method: "POST",
        headers,
        body: Buffer.concat(chunks),
        redirect: "manual",
      });
      const body = await up.text();
      res.writeHead(up.status, {
        "content-type": up.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": APP,
        "access-control-allow-credentials": "true",
      });
      res.flushHeaders();
      reached();
      await gate;
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await page.route(
    (u) => u.pathname === "/bus/approve",
    async (route) => {
      // Only the decision (step "decide") is held; typing the code is not.
      if (
        route.request().method() !== "POST" ||
        !(route.request().postData() ?? "").includes("decide")
      )
        return route.continue();
      // The cookie jar, not the request's headers: WebKit's route omits it.
      const cookie = (await page.context().cookies(APP))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      return route.continue({
        url: `http://127.0.0.1:${port}/bus/approve`,
        headers: { ...route.request().headers(), "x-forward-cookie": cookie },
      });
    },
  );
  return {
    release,
    reached: headersOut,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("approving a machine does not wait for the approve response's body", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await loginAs(
    page,
    freshEmail(`approve-body-${info.project.name}`),
    "member",
  );
  const held = await holdApproveBody(page);
  try {
    // The 200's body stays out until the test releases it: the machine token
    // must still come, because only the status and the first token request count.
    const approved = approveMachine(page);
    await held.reached;
    expect(await approved).toBeTruthy();
  } finally {
    held.release();
    await held.close();
  }
});

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
    const url = await proposeRole(page, ns, agent.name, "e2e-lead");
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
    expect(body).toContain("e2e-lead");

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
