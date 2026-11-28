import type { AgentIdentity } from "../services/agent-usage.js";

export type VersionTarget = { artifactId: string; version: number };
type Entry<Socket> = {
  socket: Socket;
  call: string;
  target?: VersionTarget;
  identity?: AgentIdentity;
};

/** The proof and the commit can arrive in either order on the original connection. */
export class PendingVersionLinks<Socket> {
  readonly #entries = new Map<string, Entry<Socket>>();
  readonly #calls = new Set<string>();

  constructor(
    private readonly write: (
      ticket: string,
      target: VersionTarget,
      identity: AgentIdentity | null,
    ) => Promise<void>,
    private readonly isOpen: (socket: Socket) => boolean,
  ) {}

  hasCall(call: string): boolean {
    return this.#calls.has(call);
  }

  start(ticket: string, socket: Socket, call: string): boolean {
    if (
      this.#entries.size >= 256 ||
      this.#entries.has(ticket) ||
      this.hasCall(call)
    )
      return false;
    this.#calls.add(call);
    this.#entries.set(ticket, { socket, call });
    return true;
  }
  async bind(ticket: string, target: VersionTarget): Promise<void> {
    const entry = this.#entries.get(ticket);
    if (!entry) return this.write(ticket, target, null);
    if (entry.target) return;
    entry.target = target;
    if (!this.isOpen(entry.socket)) return this.finish(ticket);
    if (entry.identity) await this.finish(ticket, entry.identity);
  }
  async prove(
    ticket: string,
    socket: Socket,
    identity: AgentIdentity,
  ): Promise<void> {
    const entry = this.#entries.get(ticket);
    if (!entry || entry.socket !== socket || entry.identity) return;
    entry.identity = identity;
    if (entry.target) await this.finish(ticket, identity);
  }
  async finish(
    ticket: string,
    identity: AgentIdentity | null = null,
  ): Promise<void> {
    const entry = this.#entries.get(ticket);
    if (!entry) return;
    const { call, target } = entry;
    this.#calls.delete(call);
    this.#entries.delete(ticket);
    if (target) await this.write(ticket, target, identity);
  }
  async close(socket: Socket): Promise<void> {
    await Promise.all(
      [...this.#entries]
        .filter(([, e]) => e.socket === socket)
        .map(([ticket]) => this.finish(ticket)),
    );
  }
}
