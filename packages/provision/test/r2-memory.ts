// An in-memory R2 bucket binding (get, list with delimiter) for node suites
// that read releases through r2BindingReleaseReader, and seedRelease, which
// publishes a ReleaseReader's release into it at the keys publish.ts writes.
import type { R2CatalogBucket } from "../src/gate.js";
import {
  FLOOR_KEY,
  RECORD_FILE,
  releaseKey,
  TEMPLATE_FILE,
  WELCOME_FILE,
} from "../src/publish.js";
import type { BundleVariant, ReleaseReader } from "../src/release.js";

export class MemoryR2 implements R2CatalogBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  /** The upload time a put records. */
  clock = () => 0;
  /** Every get and list, as "get <key>" or "list <prefix>". */
  readonly reads: string[] = [];
  /** A read's latency, so concurrent reads overlap (0: none). */
  delayMs = 0;
  /** The most reads in flight at once. */
  maxInFlight = 0;
  #inFlight = 0;

  async #read(what: string): Promise<void> {
    this.reads.push(what);
    if (this.delayMs === 0) return;
    this.maxInFlight = Math.max(this.maxInFlight, ++this.#inFlight);
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.#inFlight--;
  }

  async put(key: string, bytes: Uint8Array | string): Promise<void> {
    const b =
      typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    this.objects.set(key, {
      bytes: b.slice(),
      uploaded: new Date(this.clock()),
    });
  }

  async get(key: string) {
    await this.#read(`get ${key}`);
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.bytes.slice();
    return {
      size: bytes.length,
      uploaded: o.uploaded,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }

  async list(o: {
    prefix: string;
    cursor?: string;
    limit?: number;
    delimiter?: string;
  }) {
    await this.#read(`list ${o.prefix}`);
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(o.prefix))
      .sort();
    const objects: { key: string; size: number; uploaded: Date }[] = [];
    const prefixes = new Set<string>();
    for (const k of keys) {
      const rest = k.slice(o.prefix.length);
      const cut = o.delimiter ? rest.indexOf(o.delimiter) : -1;
      if (cut >= 0) prefixes.add(o.prefix + rest.slice(0, cut + 1));
      else {
        const v = this.objects.get(k);
        if (v)
          objects.push({ key: k, size: v.bytes.length, uploaded: v.uploaded });
      }
    }
    return {
      objects: objects.slice(0, o.limit ?? 1000),
      truncated: false,
      delimitedPrefixes: [...prefixes],
    };
  }
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** Publishes one release from `from` into `bucket`, at the keys publish.ts writes. */
export async function seedRelease(
  bucket: MemoryR2,
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
