const KB = 1024;

/** Every pinned value from the OpenBus spec, kept at parity in v1. Do not tune per instance. */
export const LIMITS = {
  /** A body at or below this arrives inline in `deliver`; above it, a notice + fetch. */
  inlineBodyBytes: 32 * KB,
  /** Hard cap on one message body (below SQLite's 2 MB row limit). */
  maxMessageBytes: 1024 * KB,
  /** Undelivered mail expires this long after it was sent. */
  mailTtlSec: 3600,
  /** Undelivered messages per agent, then `refused: inbox_full`. */
  inboxCap: 50,
  /** The hub stops holding a pushed-but-unacked message after this. */
  ackTimeoutMs: 10_000,
  deviceCodeTtlSec: 600,
  devicePollIntervalSec: 5,
  /** WebSocket close code on revoke (and on any socket the hub invalidates). */
  revokeCloseCode: 4403,
  /** WebSocket close code for a protocol violation. */
  protocolCloseCode: 1008,
  /** WebSocket close code when a socket exceeds its frame budget: back off at least rateLimitCooldownMs before reconnecting. */
  rateLimitCloseCode: 4429,
  /** After a rateLimitCloseCode close, the hub answers 429 to that machine's /bus/connect upgrades for this long. */
  rateLimitCooldownMs: 10_000,
  /** One live daemon socket per machine: a reconnect replaces the previous one. */
  maxSocketsPerMachine: 1,
  /** Bare-string keepalive: the daemon sends PING, the hub auto-answers PONG. */
  pingIntervalMs: 25_000,
  maxBusNameChars: 64,
  maxNamespaceChars: 128,
  maxAgentRefChars: 128,
  maxLabelChars: 64,
  /** One roster cap: wire roster, sessions open/closed, and any agent list the instance serves. */
  maxRosterAgents: 1000,
  /** Live agents one machine may hold at once; agent_up past it is refused (error `rate_limited`). The per-member cap is maxRosterAgents. */
  maxAgentsPerMachine: 200,
  /** Machines listed for one member. */
  maxMachinesListed: 100,
  /** A former name reaches its agent, and is reserved from others, this long after a rename (#393). Equals the mail TTL. */
  formerNameGraceMs: 3_600_000,
  /** Former names an agent keeps, newest first (stored and shown per roster row). Past it a default one is dropped; a chosen one in its grace never is, so a rename that would leave one more is refused (OpenBus #446). */
  maxFormerNames: 5,
  /** Name changes per agent per rolling hour, a live agent_up's included; past it `rename` gets `error rate_limited` and an agent_up keeps the current name. A no-op doesn't count. */
  renamesPerHour: 10,
} as const;

const enc = new TextEncoder();
export const utf8Bytes = (s: string): number => enc.encode(s).length;
/** True when `s` exceeds `max` UTF-8 bytes. UTF-8 bytes >= UTF-16 units, so a longer string short-circuits. */
export const utf8Exceeds = (s: string, max: number): boolean =>
  s.length > max || utf8Bytes(s) > max;
