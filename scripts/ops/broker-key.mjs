#!/usr/bin/env node
// A new Ed25519 broker key for a platform principal's registry entry (design
// v7 4.3, 4.6), as provision's newBrokerKey makes one: one JSON line
// {kid, x, pkcs8} on stdout. kid = first 16 chars of base64url(SHA-256(x));
// x is the raw public key and pkcs8 the private key's DER, both base64url.
// The caller writes the registry entry from {kid, x} and puts pkcs8 as a
// secret on stdin; nothing here is ever printed elsewhere.
import { createHash, generateKeyPairSync } from "node:crypto";

export function brokerKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  const pkcs8 = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  const kid = createHash("sha256")
    .update(Buffer.from(x, "base64url"))
    .digest("base64url")
    .slice(0, 16);
  return { kid, x, pkcs8 };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  process.stdout.write(`${JSON.stringify(brokerKey())}\n`);
