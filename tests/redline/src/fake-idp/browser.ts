import { CALLBACK_GOOGLE } from "../signin.ts";
import { FAKE_AUTHORIZE } from "./server.ts";

// The human's browser in the no-human rehearsal: follows redirects with a
// cookie jar per host, and keeps the DevTools network log of every
// callback/google request it made. It starts cookieless at the install (the
// capture script holds the state cookie, never the browser), so the install
// refuses its first callback and retries with a flow of its own (state r1.):
// the same two callbacks the human sees.

export interface BrowserStep {
  url: URL;
  status: number;
}

export class FakeBrowser {
  /** Every callback/google request, in order (what DevTools lists). */
  readonly callbacks: URL[] = [];
  readonly steps: BrowserStep[] = [];
  private jar = new Map<string, Map<string, string>>();
  private readonly o: {
    /** The fake IdP's origin: where the user picks an account. */
    idp: string;
    /** Rewrites a URL before it is fetched (local: https on *.localhost to http). */
    map?: (u: URL) => URL;
  };

  constructor(o: FakeBrowser["o"]) {
    this.o = o;
  }

  /** Opens `start` signed in at the IdP as `as` (the account picked). */
  async open(
    start: URL | string,
    as: string,
    maxHops = 16,
  ): Promise<BrowserStep> {
    let u = new URL(start);
    for (let hop = 0; hop < maxHops; hop++) {
      u = this.o.map ? this.o.map(u) : u;
      if (u.origin === this.o.idp && u.pathname === FAKE_AUTHORIZE)
        u.searchParams.set("as", as);
      if (u.pathname === CALLBACK_GOOGLE) this.callbacks.push(new URL(u));
      const jar = this.jar.get(u.host) ?? new Map<string, string>();
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(u, {
        redirect: "manual",
        headers: cookie ? { cookie } : {},
      });
      await res.body?.cancel();
      for (const line of res.headers.getSetCookie()) {
        const [pair = "", ...attrs] = line.split(";");
        const i = pair.indexOf("=");
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        const gone =
          value === "" || attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
        if (gone) jar.delete(name);
        else jar.set(name, value);
      }
      this.jar.set(u.host, jar);
      const step = { url: u, status: res.status };
      this.steps.push(step);
      const loc = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || !loc) return step;
      u = new URL(loc, u);
    }
    throw new Error("fake browser: too many redirects");
  }
}

/** Local mode: the registry and AUTH_BROKER_URL say https, the loopback servers speak http. */
export const loopbackHttp = (u: URL): URL => {
  if (u.protocol !== "https:" || !u.hostname.endsWith(".localhost")) return u;
  const v = new URL(u);
  v.protocol = "http:";
  return v;
};
