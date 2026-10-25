// The one-time per-env Turnstile widget (`oa:hosted turnstile-init`, Task 8).
// One widget per env, named platformNames(env).turnstile, managed, with
// exactly the env's app domain (a hostname covers its subdomains). Its keys
// go to the caller's store (the keychain item oa-hosted-<env>-turnstile);
// create later reads that pair. Idempotent: a matching widget is reused, and
// a same-named one that differs is refused. The secret is never returned,
// printed or put in an error.
import type { Cf } from "./cf.js";
import { type Env, ForeignResource, platformNames } from "./names.js";
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

export async function turnstileInit(o: {
  cf: Cf;
  env: Env;
  store: TurnstileStore;
}): Promise<{ created: boolean; stored: boolean }> {
  const { cf, env, store } = o;
  if (env !== "staging" && env !== "prod") throw new ForeignResource("", env);
  const name = platformNames(env).turnstile;
  const domain = HOSTED_DOMAINS[env].app;
  const mine = (await cf.turnstileList()).filter((w) => w.name === name);
  const saved = await store.read();
  if (mine.length > 1)
    throw new TurnstileRefused(
      `${mine.length} widgets are named ${name}; keep one and delete the rest in the dashboard`,
    );
  const w = mine[0];
  if (!w) {
    if (saved)
      throw new TurnstileRefused(
        `the keychain item holds widget ${saved.sitekey}, which is not on the account as ${name}; remove the item, then rerun`,
      );
    const made = await cf.turnstileCreate({
      name,
      domains: [domain],
      mode: "managed",
    });
    await store.write(made);
    return { created: true, stored: true };
  }
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
