/**
 * Set by BrokerGate (gate.ts) on every request it forwards over a service
 * binding: the install the gate is bound to. The brokers key their per-IP
 * rate limit on it for gate traffic (core.ts rateKeyOf). Its own module, so
 * the gate's bundle (dispatch, scheduler) doesn't pull in the rest of core.
 */
export const GATE_INSTALL_HEADER = "x-oa-gate-install";

/**
 * Set by BillingGate on POST /checkout and /portal only: the install's app
 * host, from the gate's props (dispatch and the scheduler take it from the
 * install's platform record, never from a request). Billing builds the
 * Stripe success, cancel and return URLs from it and nothing else.
 */
export const GATE_APP_HOST_HEADER = "x-oa-gate-app-host";
