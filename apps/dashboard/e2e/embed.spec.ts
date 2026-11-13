// Embed mode (mock): a page on another origin frames /a/<id>/full. The shell
// detects that itself (no meta, param or header), runs anonymously, never
// hands the artifact the viewer's identity, stays on its page, and shows the
// not-public panel instead of a sign-in redirect. frame-ancestors is
// server-side and not exercised here.
import {
  type BrowserContext,
  expect,
  type Frame,
  type Page,
  test,
} from "@playwright/test";

const APP = "http://localhost:5199";
// Another origin (and site) that is still a secure context, so the framed
// app's mock service worker can run: 127.0.0.1 vs localhost.
const ATTACKER = "http://127.0.0.1:5199/__attacker";
const POLL = "Gh9kLmNpQrAsTuVx"; // public, db, anonymous writes
const LANDING = "Cd5fGhJkLm6nPqRs"; // private
const EMAIL = "ada@example.com"; // the mock session's user

type Call = {
  url: string;
  credentials: string;
  auth: string | null;
  embed: string | null;
  anonId: string | null;
};

/**
 * In every frame of the app's origin: log each fetch as it leaves the page
 * (after the mock session's auth wrapper), log data sockets, and play the
 * server's part the shared mocks skip: an anonymous read of the private
 * artifact 404s. The poll declares the viewer capability, so a leak would show.
 */
const instrument = (context: BrowserContext) =>
  context.addInitScript(
    ({ APP, POLL, LANDING }) => {
      if (location.origin !== APP) return;
      const w = window as unknown as { __calls: unknown[]; __ws: string[] };
      w.__calls = [];
      w.__ws = [];
      const f = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const req = new Request(input, init);
        const path = new URL(req.url).pathname;
        if (path.startsWith("/api/"))
          w.__calls.push({
            url: path,
            credentials: req.credentials,
            auth: req.headers.get("authorization"),
            embed: req.headers.get("x-oa-embed"),
            anonId: req.headers.get("x-oa-anon-id"),
          });
        const anon = !req.headers.has("authorization");
        if (anon && path.startsWith(`/api/v1/artifacts/${LANDING}`))
          return new Response(
            JSON.stringify({
              error: { code: "not_found", message: "Not found" },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        // The shared mocks have no /anon-id: answer as the server would, for
        // anonymous callers only.
        if (path === `/api/v1/artifacts/${POLL}/anon-id`)
          return anon
            ? new Response(JSON.stringify({ anonId: "AnonPoll" }), {
                headers: {
                  "content-type": "application/json",
                  "X-OA-Anon-Id": `${"a".repeat(22)}.${"b".repeat(43)}`,
                },
              })
            : new Response(
                JSON.stringify({
                  error: { code: "unauthorized", message: "Logged in" },
                }),
                {
                  status: 401,
                  headers: { "content-type": "application/json" },
                },
              );
        const res = await f(req);
        if (path === `/api/v1/artifacts/${POLL}` && res.ok) {
          const body = await res.json();
          body.capabilities.viewer = true;
          return new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          });
        }
        return res;
      };
      const WS = window.WebSocket;
      window.WebSocket = class extends WS {
        constructor(url: string | URL, p?: string | string[]) {
          super(url, p);
          w.__ws.push(String(url));
        }
      };
    },
    { APP, POLL, LANDING },
  );

/** The artifact: a bare runtime client that records every shell message. */
const ARTIFACT = `<!doctype html><script>
  // The shell's per-load nonce rides in the fragment (#oa=...).
  const nonce = new URLSearchParams(location.hash.slice(1)).get("oa");
  window.__msgs = [];
  addEventListener("message", (e) => window.__msgs.push(e.data));
  window.__call = (id, method, params) =>
    parent.postMessage({ oa: 1, type: "call", id, method, params, nonce }, "*");
  parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html", nonce }, "*");
</script><p>artifact</p>`;

const serve = async (context: BrowserContext) => {
  await context.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: ARTIFACT }),
  );
  await context.route(
    (u) => u.href.startsWith(ATTACKER),
    (r) => {
      const id = new URL(r.request().url()).searchParams.get("id");
      // No hint: no meta, no embed param, nothing but a plain iframe.
      return r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>attacker</title><iframe src="${APP}/a/${id}/full" style="width:800px;height:600px;border:0"></iframe>`,
      });
    },
  );
  // A valid session cookie for the app, sent cross-site if anything asks for it.
  await context.addCookies([
    {
      name: "oa_session",
      value: "valid",
      domain: "localhost",
      path: "/",
      sameSite: "None",
      secure: true,
      httpOnly: true,
    },
  ]);
};

// The attacker page is fulfilled by a route, so Chrome counts it as public and
// would block it from framing a loopback address.
test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

test.beforeEach(async ({ context }) => {
  await instrument(context);
  await serve(context);
});

const appFrame = async (page: Page): Promise<Frame> => {
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith(`${APP}/a/`)))
    .toBe(true);
  return page.frames().find((f) => f.url().startsWith(`${APP}/a/`)) as Frame;
};
const contentFrame = async (page: Page): Promise<Frame> => {
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().startsWith("https://content.example")),
    )
    .toBe(true);
  return page
    .frames()
    .find((f) => f.url().startsWith("https://content.example")) as Frame;
};
const calls = (f: Frame) =>
  f.evaluate(() => (window as unknown as { __calls: Call[] }).__calls);
const msgs = (f: Frame) =>
  f.evaluate(
    () => (window as unknown as { __msgs: Record<string, unknown>[] }).__msgs,
  );
const reply = async (f: Frame, id: string) => {
  await expect
    .poll(async () => (await msgs(f)).some((m) => m.id === id))
    .toBe(true);
  return (await msgs(f)).find((m) => m.id === id) as Record<string, unknown>;
};

test("(a) an attacker frame with a session cookie and no hint stays anonymous", async ({
  page,
}) => {
  const cookieRequests: string[] = [];
  page.on("request", async (r) => {
    if (!r.url().startsWith(`${APP}/api/`)) return;
    const h = await r.allHeaders().catch(() => ({}) as Record<string, string>);
    if (h.cookie || h.authorization) cookieRequests.push(r.url());
  });
  await page.goto(`${ATTACKER}/?id=${POLL}`);
  const app = await appFrame(page);
  const artifact = await contentFrame(page);

  await artifact.evaluate(() =>
    (window as unknown as { __call: (...a: unknown[]) => void }).__call(
      "v",
      "viewer.get",
      {},
    ),
  );
  expect((await reply(artifact, "v")).value).toBeNull();
  const welcome = (await msgs(artifact)).find((m) => m.type === "welcome");
  expect(welcome?.viewer).toBeNull();
  expect(JSON.stringify(await msgs(artifact))).not.toContain(EMAIL);

  // The anonymous-id paths: minting via /anon-id, then a write that carries
  // the signed token header. Both stay uncredentialed.
  await artifact.evaluate(() => {
    const call = (window as unknown as { __call: (...a: unknown[]) => void })
      .__call;
    call("id", "viewer.anonId", {});
  });
  expect((await reply(artifact, "id")).value).toBe("AnonPoll");
  await artifact.evaluate(() =>
    (window as unknown as { __call: (...a: unknown[]) => void }).__call(
      "w",
      "db.set",
      { collection: "votes", id: "x", data: { v: 1 } },
    ),
  );
  expect(await reply(artifact, "w")).toMatchObject({ ok: true });
  expect(JSON.stringify(await msgs(artifact))).not.toContain("a".repeat(22));

  const seen = await calls(app);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.some((c) => c.url.endsWith("/anon-id"))).toBe(true);
  expect(seen.some((c) => c.anonId !== null)).toBe(true);
  for (const c of seen) {
    expect(c, c.url).toMatchObject({
      credentials: "omit",
      auth: null,
      embed: "1",
    });
  }
  expect(seen.some((c) => c.url === "/api/v1/me")).toBe(false);
  expect(cookieRequests).toEqual([]);

  // Nothing signed-in: the chip only offers a new tab.
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("link", { name: /in Open Artifacts \(opens in new tab\)/ }),
  ).toBeAttached();
  await expect(
    page.frameLocator("iframe").getByText("Exit full screen"),
  ).toHaveCount(0);
});

test("(b) top-level /full with a session stays logged in", async ({ page }) => {
  await page.goto(`/a/${POLL}/full`);
  const app = page.mainFrame();
  const artifact = await contentFrame(page);
  await artifact.evaluate(() =>
    (window as unknown as { __call: (...a: unknown[]) => void }).__call(
      "v",
      "viewer.get",
      {},
    ),
  );
  expect((await reply(artifact, "v")).value).toMatchObject({ email: EMAIL });
  const seen = await calls(app);
  expect(seen.some((c) => c.url === "/api/v1/me")).toBe(true);
  for (const c of seen)
    expect(c, c.url).toMatchObject({
      credentials: "same-origin",
      auth: "Bearer mock",
      embed: null,
    });
  await expect(
    page.getByRole("link", { name: /^Exit full screen/ }),
  ).toBeAttached();
});

test("(c) framed navigation is blocked or opens a new tab", async ({
  page,
  context,
}) => {
  await page.goto(`${ATTACKER}/?id=${POLL}`);
  const app = await appFrame(page);
  await contentFrame(page);
  const at = `${APP}/a/${POLL}/full`;

  // History API: dropped.
  await app.evaluate(() => {
    history.pushState(null, "", "/settings/profile");
    history.replaceState(null, "", "/");
  });
  expect(app.url()).toBe(at);

  // A plain in-app link: a new tab with no opener; the frame stays.
  await app.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/settings/profile";
    a.textContent = "Settings";
    a.id = "nav-test";
    document.body.append(a);
  });
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    app.click("#nav-test"),
  ]);
  await expect(tab).toHaveURL(`${APP}/settings/profile`);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
  expect(app.url()).toBe(at);

  // The chip: a new tab to the artifact.
  const [tab2] = await Promise.all([
    context.waitForEvent("page"),
    page
      .frameLocator("iframe")
      .getByRole("link", { name: /in Open Artifacts/ })
      .click(),
  ]);
  await expect(tab2).toHaveURL(`${APP}/a/${POLL}`);
  expect(app.url()).toBe(at);
  await expect(app.locator("iframe.oa-vframe")).toBeVisible();
});

test("(d) a framed private artifact shows the placeholder, not a login redirect", async ({
  page,
}) => {
  const logins: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/auth/")) logins.push(r.url());
  });
  await page.goto(`${ATTACKER}/?id=${LANDING}`);
  const app = await appFrame(page);
  const frame = page.frameLocator("iframe");
  await expect(
    frame.getByRole("heading", { name: "This artifact isn't public" }),
  ).toBeVisible();
  const open = frame.getByRole("link", { name: "Open in Open Artifacts" });
  await expect(open).toHaveAttribute("href", `/a/${LANDING}`);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noopener");
  await expect(frame.locator("iframe.oa-vframe")).toHaveCount(0);
  expect(app.url()).toBe(`${APP}/a/${LANDING}/full`);
  expect(logins).toEqual([]);
  // The title of a private artifact never shows.
  expect(await app.title()).not.toContain("Landing page");
});

test("(e) a framed public live artifact works anonymously", async ({
  page,
}) => {
  await page.goto(`${ATTACKER}/?id=${POLL}`);
  const app = await appFrame(page);
  const artifact = await contentFrame(page);
  const call = (id: string, method: string, params: unknown) =>
    artifact.evaluate(
      ([id, method, params]) =>
        (window as unknown as { __call: (...a: unknown[]) => void }).__call(
          id,
          method,
          params,
        ),
      [id, method, params] as const,
    );

  await call("id", "viewer.anonId", {});
  expect(await reply(artifact, "id")).toMatchObject({
    ok: true,
    value: "AnonPoll",
  });
  expect((await calls(app)).some((c) => c.url.endsWith("/anon-id"))).toBe(true);

  await call("s", "db.subscribe", { collection: "votes" });
  expect(await reply(artifact, "s")).toMatchObject({ ok: true });
  await call("w", "db.set", {
    collection: "votes",
    id: "anon1",
    data: { choice: "yes" },
  });
  expect(await reply(artifact, "w")).toMatchObject({ ok: true });
  await call("l", "db.list", { collection: "votes" });
  const list = await reply(artifact, "l");
  expect(list.ok).toBe(true);
  expect(JSON.stringify(list.value)).toContain("anon1");

  // Data sockets only (not vite's HMR socket).
  const ws = (
    await app.evaluate(() => (window as unknown as { __ws: string[] }).__ws)
  ).filter((u) => new URL(u).pathname.startsWith("/api/"));
  expect(ws.length).toBeGreaterThan(0);
  for (const u of ws) expect(new URL(u).searchParams.get("embed")).toBe("1");
  for (const c of await calls(app))
    expect(c, c.url).toMatchObject({ credentials: "omit", auth: null });
});
