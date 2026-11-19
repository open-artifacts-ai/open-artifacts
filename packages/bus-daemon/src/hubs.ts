import { BUS_CAPS, type ClientFrame } from "@oa/bus-protocol";
import type { Config } from "./config.ts";
import type { HubConnection } from "./hub.ts";
import { MAIN_INSTANCE } from "./instances.ts";
import { Resends } from "./resend.ts";

/**
 * One hub link and what the daemon has learned on it (#2793 S3). Main is the
 * machine.json instance; the others are added instances. Everything here is
 * per link: a drop or a revoke on one never touches another.
 */
export class Lane {
  /** Set once, right after the connection is built. */
  hub!: HubConnection;
  /** This link has had its hello_ok (reset when the link drops). */
  helloed = false;
  version?: string;
  ids = false;
  mailbox = false;
  nameChosen = false;
  follow = false;
  link = false;
  linkArg = false;
  ackConfirm = false;
  waiting = false;
  waitingQuery = false;
  runCap = false;
  ever = false;
  droppedAt?: number;
  /** The hub refused this instance's token; its link stays closed. */
  revoked = false;
  /** agent_up ids awaiting the hub's answer, to their agent_ref and the kind sent; cleared with the link. */
  readonly upIds = new Map<string, { ref: string; kind: string }>();
  /** rename ids awaiting the hub's answer, to their agent_ref; cleared with the link. */
  readonly renameIds = new Map<string, { ref: string; prevSent?: string }>();

  constructor(
    readonly name: string,
    readonly cfg: Config,
  ) {}

  get main(): boolean {
    return this.name === MAIN_INSTANCE;
  }

  /** What a hello_ok says this hub supports. */
  applyHello(caps: readonly string[] | undefined, serverVersion: string): void {
    const has = (c: string) => caps?.includes(c) ?? false;
    this.version = serverVersion;
    this.ids = has(BUS_CAPS.ids);
    this.mailbox = has(BUS_CAPS.mailbox);
    this.nameChosen = has(BUS_CAPS.nameChosen);
    this.follow = has(BUS_CAPS.follow);
    this.waiting = has(BUS_CAPS.waiting);
    this.waitingQuery = has(BUS_CAPS.waitingQuery);
    this.link = has(BUS_CAPS.link);
    this.linkArg = has(BUS_CAPS.linkArg);
    this.ackConfirm = has(BUS_CAPS.ackConfirm);
    this.runCap = has(BUS_CAPS.runVersion);
    this.helloed = true;
  }

  /** The link dropped: the next hello_ok says again which hub this is. */
  resetLink(): void {
    this.upIds.clear();
    this.renameIds.clear();
    this.version = undefined;
    this.ids = false;
    // A replay before the next hello_ok must not carry `replaces`.
    this.mailbox = false;
    this.nameChosen = false;
    this.follow = false;
    this.link = false;
    this.linkArg = false;
    this.ackConfirm = false;
    this.waitingQuery = false;
    this.helloed = false;
    this.runCap = false;
  }
}

/** Every link of this daemon. Fixed once the daemon has started. */
export class Lanes {
  readonly #by = new Map<string, Lane>();
  add(lane: Lane): void {
    this.#by.set(lane.name, lane);
  }
  get(name: string | undefined): Lane | undefined {
    return name === undefined ? undefined : this.#by.get(name);
  }
  all(): Lane[] {
    return [...this.#by.values()];
  }
  /** More than one link: frames are then routed by (instance, agent). */
  get multi(): boolean {
    return this.#by.size > 1;
  }
}

/** A map that forgets its oldest entries past `max`. */
export class BoundedMap<K, V> {
  readonly #m = new Map<K, V>();
  constructor(private readonly max: number) {}
  set(k: K, v: V): void {
    this.#m.delete(k);
    this.#m.set(k, v);
    while (this.#m.size > this.max)
      this.#m.delete(this.#m.keys().next().value as K);
  }
  get(k: K): V | undefined {
    return this.#m.get(k);
  }
}

/** Frames carry at most one agent: the sender, or the agent the frame is about. */
export function refOf(f: ClientFrame): string | undefined {
  if ("from_ref" in f) return f.from_ref;
  if ("agent_ref" in f) return f.agent_ref;
  return undefined;
}

type ResendOpts = ConstructorParameters<typeof Resends>[0];

/**
 * One Resends per link, so a link that drops only touches the sends that went
 * out on it. With a single link this is that one Resends.
 */
export class ResendSet {
  readonly #by = new Map<string, Resends>();
  constructor(mk: (lane: Lane) => ResendOpts, lanes: Lane[]) {
    for (const l of lanes) this.#by.set(l.name, new Resends(mk(l)));
  }
  #of(lane: Lane): Resends {
    return this.#by.get(lane.name) as Resends;
  }
  #each<T>(fn: (r: Resends) => T | undefined): T | undefined {
    for (const r of this.#by.values()) {
      const v = fn(r);
      if (v) return v;
    }
    return undefined;
  }
  track(lane: Lane, frame: Parameters<Resends["track"]>[0], native: boolean) {
    this.#of(lane).track(frame, native);
  }
  untrack(id: string): void {
    for (const r of this.#by.values()) r.untrack(id);
  }
  frame(id: string) {
    return this.#each((r) => r.frame(id));
  }
  held(id: string): boolean {
    return this.#each((r) => (r.held(id) ? true : undefined)) ?? false;
  }
  dropped(lane: Lane): void {
    this.#of(lane).dropped();
  }
  up(lane: Lane, ref: string): void {
    this.#of(lane).up(ref);
  }
  limited(id: string): boolean {
    return this.#each((r) => (r.limited(id) ? true : undefined)) ?? false;
  }
  stop(): void {
    for (const r of this.#by.values()) r.stop();
  }
}
