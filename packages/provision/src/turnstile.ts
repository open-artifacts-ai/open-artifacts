// The one-time per-env Turnstile widget (`oa:hosted turnstile-init`, Task 8).
// One widget per env, named platformNames(env).turnstile, managed, with
// exactly the env's app domain (a hostname covers its subdomains). Its keys
// go to the caller's store (the keychain item oa-hosted-<env>-turnstile);
// create later reads that pair. Idempotent: a matching widget is reused, and
// a same-named one that differs is refused, and every create attempt is
// preceded by a listing by name, so a lost reply is adopted rather than
// duplicated. The secret is never returned,
// printed or put in an error.
import { type Cf, CfError, type TurnstileWidget } from "./cf.js";
import {
  assertOwnResource,
  type Env,
  ForeignResource,
  platformNames,
} from "./names.js";
import { HOSTED_DOMAINS } from "./wfp.js";

export interface TurnstileKeys {
  sitekey: string;
  secret: string;
}

export interface TurnstileStore {
  read(): Promise<TurnstileKeys | null>;
  write(k: TurnstileKeys): Promise<void>;
}

export class TurnstileRefused extends Error {
  override name = "TurnstileRefused";
}

/** Create attempts; every one is preceded by a listing by the exact name. */
const ATTEMPTS = 3;

export async function turnstileInit(o: {
  cf: Cf;
  env: Env;
  store: TurnstileStore;
  /** Backoff between create attempts (1 s, then 2 s). */
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ created: boolean; stored: boolean }> {
  const { cf, env, store } = o;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if (env !== "staging" && env !== "prod") throw new ForeignResource("", env);
  const name = platformNames(env).turnstile;
  const domain = HOSTED_DOMAINS[env].app;
  const saved = await store.read();
  /** The one widget named `name`, or null; two or more are refused. */
  const find = async () => {
    const mine = (await cf.turnstileList()).filter((w) => w.name === name);
    if (mine.length > 1)
      throw new TurnstileRefused(
        `${mine.length} widgets are named ${name} (${mine.map((w) => w.sitekey).join(", ")}); keep one and delete the rest in the dashboard`,
      );
    return mine[0] ?? null;
  };
  let w = await find();
  if (!w) {
    if (saved)
      throw new TurnstileRefused(
        `the keychain item holds widget ${saved.sitekey}, which is not on the account as ${name}; remove the item, then rerun`,
      );
    for (let i = 1; ; i++) {
      let made: TurnstileKeys;
      assertOwnResource(name, env);
      try {
        made = await cf.turnstileCreate({
          name,
          domains: [domain],
          mode: "managed",
        });
      } catch (e) {
        // A lost reply may have created it: list again before any retry,
        // and adopt that widget rather than make a second one.
        w = await find();
        if (w) break;
        const refused =
          e instanceof CfError &&
          e.status >= 400 &&
          e.status < 500 &&
          e.status !== 429;
        if (refused || i >= ATTEMPTS) throw e;
        await sleep(1000 * i);
        continue;
      }
      await store.write(made);
      return { created: true, stored: true };
    }
  }
  return adopt(cf, store, saved, w, name, domain);
}

/** An existing widget: verified as the env's, then its keys stored if they are not. */
async function adopt(
  cf: Cf,
  store: TurnstileStore,
  saved: TurnstileKeys | null,
  w: TurnstileWidget,
  name: string,
  domain: string,
): Promise<{ created: boolean; stored: boolean }> {
  if (
    !Array.isArray(w.domains) ||
    w.domains.length !== 1 ||
    w.domains[0] !== domain ||
    w.mode !== "managed"
  )
    throw new TurnstileRefused(
      `widget ${w.sitekey} is named ${name} but differs (want mode managed and domains exactly [${domain}]); fix or delete it in the dashboard`,
    );
  if (saved && saved.sitekey !== w.sitekey)
    throw new TurnstileRefused(
      `the keychain item holds widget ${saved.sitekey}, not ${name} (${w.sitekey}); remove the item, then rerun`,
    );
  const full = await cf.turnstileWidget(w.sitekey);
  if (!full || full.sitekey !== w.sitekey || typeof full.secret !== "string")
    throw new TurnstileRefused(
      `widget ${w.sitekey}: its secret could not be read`,
    );
  if (saved) {
    if (saved.secret !== full.secret)
      throw new TurnstileRefused(
        `the keychain item's secret is not widget ${w.sitekey}'s current secret; remove the item, then rerun`,
      );
    return { created: false, stored: false };
  }
  await store.write({ sitekey: w.sitekey, secret: full.secret });
  return { created: false, stored: true };
}
