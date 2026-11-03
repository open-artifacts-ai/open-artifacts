// #1188: the mock-parity cases (mock-parity.ts) against the provisioning MSW
// mock. apps/provisioning/test/mock-parity.test.ts runs them on the worker.
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createProvisioningMock } from "../../src/mocks/provisioning.js";
import { ROUTES } from "../../src/provisioning/routes.js";
import { mockParity, type ParityDriver } from "./mock-parity.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const B = "https://admin.open-artifacts.app/api/v1";

const msw: ParityDriver = {
  mock: true,
  fresh: async () => {
    server.resetHandlers();
    server.use(...createProvisioningMock({ env: "staging" }).handlers);
  },
  call: async (route, input = {}) => {
    let path = ROUTES[route].path;
    for (const [k, v] of Object.entries(input.params ?? {}))
      path = path.replace(`:${k}`, encodeURIComponent(v));
    const q = new URLSearchParams(input.query ?? {}).toString();
    const r = await fetch(`${B}${path}${q ? `?${q}` : ""}`);
    return { status: r.status, body: await r.json() };
  },
  // The mock has no signups; the worker's R2 q reads their emails too.
  addPendingSignup: async () => {},
  knownGaps: {
    "R2: q on a pending signup's email": {
      why: "the mock has no signups, so q never matches one's email (#1196: https://github.com/open-artifacts-ai/open-artifacts/issues/1196)",
    },
  },
};

mockParity(msw);
