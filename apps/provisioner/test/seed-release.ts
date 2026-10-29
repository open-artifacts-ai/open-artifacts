import {
  FLOOR_KEY,
  RECORD_FILE,
  releaseKey,
  TEMPLATE_FILE,
  WELCOME_FILE,
} from "../../../packages/provision/src/publish.js";
import type {
  BundleVariant,
  ReleaseReader,
} from "../../../packages/provision/src/release.js";

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** Publishes one release from `from` into `bucket`, at the keys publish.ts writes. */
export async function seedRelease(
  bucket: R2Bucket,
  from: ReleaseReader,
  version: string,
  variant: BundleVariant,
): Promise<void> {
  const at = (rel: string) => releaseKey(version, variant, rel);
  const { modules } = await from.modules(version, variant);
  for (const m of modules) await bucket.put(at(`modules/${m.name}`), m.bytes);
  for (const a of await from.assets(version, variant))
    await bucket.put(
      at(`assets/${a.path}`),
      await from.assetBytes(version, variant, a.path),
    );
  await bucket.put(at(TEMPLATE_FILE), await from.template(version, variant));
  for (const f of await from.migrations(version, variant))
    await bucket.put(at(`migrations/${f.name}`), f.bytes);
  await bucket.put(at(WELCOME_FILE), await from.welcome(version, variant));
  await bucket.put(FLOOR_KEY, json(await from.floor()));
  await bucket.put(at(RECORD_FILE), json(await from.record(version, variant)));
}
