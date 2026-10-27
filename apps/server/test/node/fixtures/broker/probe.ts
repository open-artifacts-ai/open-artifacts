// Fixture for broker-transport-lint.test.ts: every way a broker could be
// reached around the helper. Never imported.
type E = {
  AUTH_BROKER_URL: string;
  DIRECTORY_BROKER_URL: string;
  BROKER: { fetch(r: Request): Promise<Response> };
};

export async function direct(env: E) {
  return fetch(`${env.AUTH_BROKER_URL}/google/redeem`, { method: "POST" });
}

export async function viaGlobal(env: E) {
  return globalThis.fetch(env.DIRECTORY_BROKER_URL);
}

export async function viaBinding(env: E, r: Request) {
  return env.BROKER.fetch(r);
}

export async function viaProps(ctx: { props: Record<string, never> }) {
  return ctx.props.AUTH_BROKER;
}

export const later = (u: string) => self.fetch(u);

export async function elementCall(env: E) {
  return globalThis["fetch"](env.AUTH_BROKER_URL);
}

export async function viaAlias(env: E) {
  const f = fetch;
  return f(env.DIRECTORY_BROKER_URL);
}

export const { fetch: g } = { fetch: window.fetch };

// Not the global fetch: a method, a key, another object's property.
export const notGlobal = {
  fetch(r: Request) {
    return r;
  },
  other: (o: { fetch(): void }) => o.fetch(),
};
