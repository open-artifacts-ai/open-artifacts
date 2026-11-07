import { fetchAndWait } from "../helpers.js";

// #1426: a stand-in for the browser on the bus confirm pages. The link is
// `<origin><base>#<secret>`; the browser requests `<base>` alone, and the
// page's script posts the secret in a body. Every request URL is recorded so
// a test can assert none holds the secret.

type App = Parameters<typeof fetchAndWait>[0];

/** A response whose body is the card's HTML when the server answered with a card (JSON), else as sent. */
async function asHtml(res: Response): Promise<Response> {
  const text = await res.text();
  const h = new Headers(res.headers);
  if ((h.get("content-type") ?? "").startsWith("application/json")) {
    const j = JSON.parse(text) as { html: string };
    h.set("content-type", "text/html; charset=utf-8");
    return new Response(j.html, { status: res.status, headers: h });
  }
  return new Response(text, { status: res.status, headers: h });
}

export function confirmBrowser(app: App, origin: string, base: string) {
  const urls: string[] = [];
  const send = (e: unknown, url: string, init?: RequestInit) => {
    urls.push(url);
    return fetchAndWait(app, new Request(url, init), e);
  };

  /** GET the page (no secret), then its script's details request. Non-page responses come back as they are. */
  async function get(
    secret: string,
    headers: Record<string, string>,
    e: unknown,
  ) {
    const page = await send(e, `${origin}${base}`, { headers });
    const text = await page.text();
    const csrf = /data-csrf="([^"]+)"/.exec(text)?.[1];
    if (page.status !== 200 || csrf === undefined || !text.includes('id="c"'))
      return new Response(text, { status: page.status, headers: page.headers });
    return details(secret, headers, csrf, e);
  }

  async function details(
    secret: string,
    headers: Record<string, string>,
    pageCsrf: string,
    e: unknown,
  ) {
    return asHtml(
      await postJson(e, `${base}/view`, headers, { secret, csrf: pageCsrf }),
    );
  }

  function postJson(
    e: unknown,
    path: string,
    headers: Record<string, string>,
    body: Record<string, string>,
  ) {
    const text = JSON.stringify(body);
    return send(e, `${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(text).length),
        ...headers,
      },
      body: text,
    });
  }

  /** The card's own form fields (csrf, decision) plus the secret, posted as the script does. */
  async function post(
    secret: string,
    headers: Record<string, string>,
    fields: [string, string][],
    e: unknown,
  ) {
    return asHtml(
      await postJson(e, base, headers, {
        secret,
        ...Object.fromEntries(fields),
      }),
    );
  }

  return { urls, get, details, post, postJson, send };
}
