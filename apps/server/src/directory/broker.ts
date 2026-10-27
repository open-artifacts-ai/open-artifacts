import {
  type Box,
  boxKeyPair,
  keyId,
  openFromBroker,
  publicFromPkcs8,
  signRequest,
} from "@oa/auth-core";
import {
  BrokerUnavailableError,
  brokerFetch,
} from "../auth/broker-transport.js";
import type { Env } from "../env.js";
import { open } from "./crypto.js";
import {
  type ConsentCallback,
  type DirectoryClient,
  type DirectoryTransport,
  grantOf,
  TransportError,
} from "./transport.js";

// The broker transport (hosted): the directory broker (apps/directory-broker,
// its own Worker on directory.<zone>) holds the Directory client secret.
// This install signs every token request with its own Ed25519 key
// (BROKER_SIGNING_KEY, the P2 install assertion) over a path-bound
// transcript, so a sign-in redeem signature never works here. Each request
// carries a fresh X25519 key; the broker seals every token in its answer to
// that key only, and the private half never leaves this call.

export const DIRECTORY_START = "/google/directory/start";
export const DIRECTORY_TOKEN = "/google/directory/token";
export const DIRECTORY_REVOKE = "/google/directory/revoke";

type Broker = Extract<DirectoryTransport, { kind: "broker" }>;

const kids = new Map<string, Promise<string>>();
const kidOf = (signingKey: string) => {
  let k = kids.get(signingKey);
  if (!k) {
    k = publicFromPkcs8(signingKey).then(keyId);
    k.catch(() => kids.delete(signingKey));
    kids.set(signingKey, k);
  }
  return k;
};

/** One POST to a broker route, signed with the install assertion for `path`. */
async function signedPost(
  env: Env,
  t: Broker,
  path: string,
  body: Record<string, unknown>,
): Promise<{ res: Response; kid: string }> {
  const text = JSON.stringify({
    install: t.installId,
    ts: Date.now(),
    ...body,
  });
  const kid = await kidOf(t.signingKey);
  const req = new Request(`${t.brokerUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-kid": kid,
      "x-oa-sig": await signRequest(t.signingKey, path, kid, text),
    },
    body: text,
    redirect: "manual",
  });
  try {
    // A binding, the invocation's DIRECTORY_BROKER capability, or (never
    // hosted) public HTTPS to DIRECTORY_BROKER_URL; the request is signed.
    return { res: await brokerFetch(env, "directory", req), kid };
  } catch (e) {
    if (e instanceof BrokerUnavailableError)
      throw new TransportError("broker_unavailable");
    throw new TransportError("exchange");
  }
}

/**
 * One signed POST to the broker's token route. Resolves to the outer JSON
 * and the opened box (the tokens), or throws a TransportError.
 */
async function post(
  env: Env,
  t: Broker,
  body: Record<string, unknown>,
): Promise<{ out: Record<string, unknown>; tokens: Record<string, unknown> }> {
  const self = await boxKeyPair();
  const { res, kid } = await signedPost(env, t, DIRECTORY_TOKEN, {
    epk: self.pub,
    ...body,
  });
  const out = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!res.ok) {
    if (res.status === 401) throw new TransportError("refused");
    if (out?.error === "invalid_grant")
      throw new TransportError("invalid_grant");
    throw new TransportError("exchange");
  }
  try {
    const tokens = JSON.parse(
      await openFromBroker(self, t.installId, kid, out?.box as Box),
    ) as Record<string, unknown>;
    return { out: out ?? {}, tokens: tokens ?? {} };
  } catch {
    throw new TransportError("exchange");
  }
}

export function brokerClient(env: Env, t: Broker): DirectoryClient {
  return {
    kind: "broker",
    beginConsent({ state, challenge }) {
      // The broker adds the hd hint from its registry entry for this install.
      const u = new URL(`${t.brokerUrl}${DIRECTORY_START}`);
      u.search = new URLSearchParams({
        install: t.installId,
        state,
        code_challenge: challenge,
      }).toString();
      return u.toString();
    },
    async completeConsent(cb: ConsentCallback) {
      if (!cb.bstate) throw new TransportError("refused");
      const { tokens } = await post(env, t, {
        grant: "code",
        code: cb.code,
        verifier: cb.verifier,
        bstate: cb.bstate,
      });
      // The broker's client id is not this install's to know: aud unchecked
      // (the broker fetched the token from Google itself).
      // The granted scope comes from inside the box, like the tokens.
      return grantOf(tokens, null);
    },
    async accessToken(sealedRefresh) {
      const { tokens } = await post(env, t, {
        grant: "refresh",
        refresh_token: await open(env, sealedRefresh),
      });
      if (typeof tokens.access_token !== "string")
        throw new TransportError("exchange");
      return tokens.access_token;
    },
    async revoke(sealedRefresh) {
      const { res } = await signedPost(env, t, DIRECTORY_REVOKE, {
        refresh_token: await open(env, sealedRefresh),
      });
      await res.body?.cancel();
      if (res.status === 401) throw new TransportError("refused");
      if (!res.ok) throw new TransportError("exchange");
    },
  };
}
