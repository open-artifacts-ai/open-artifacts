/**
 * Set by BrokerGate (gate.ts) on every request it forwards over a service
 * binding: the install the gate is bound to. The brokers key their per-IP
 * rate limit on it for gate traffic (core.ts rateKeyOf). Its own module, so
 * the gate's bundle (dispatch, scheduler) doesn't pull in the rest of core.
 */
export const GATE_INSTALL_HEADER = "x-oa-gate-install";
