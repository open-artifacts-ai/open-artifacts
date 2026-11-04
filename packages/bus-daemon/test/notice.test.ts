import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyFn } from "../src/deliver.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const ID = "mmmmmmmmmmmmmmm1";
const sentFile = () =>
  join(mkdtempSync(join(tmpdir(), "ob-sent-")), "sent.json");

async function sentPending(
  h: Awaited<ReturnType<typeof daemonHarness>>,
  kind: "claude-code" | "opencode" | "pi" = "claude-code",
  body = "hi",
) {
  const a = await h.adapter("A", { kind });
  const reply = a.request({ type: "send", to: "peer", body });
  const sent = await h.next("send");
  h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
  await reply;
}

describe("receipt_update notices", () => {
  it.each([
    [
      { state: "expired" },
      '×  Expired: your message to peer, "hi",\n   was not taken within 1 hour.',
    ],
    [
      { state: "expired", reason: "recipient_closed" },
      '×  Expired: your message to peer, "hi",\n   was not delivered because peer closed first.',
    ],
    [
      { state: "refused", reason: "closed" },
      '×  Refused (closed): your message to peer, "hi",\n   was not delivered.\n   Send it again once the session is open, or message another agent.',
    ],
    [
      { state: "refused", reason: "ambiguous" },
      '×  Refused (ambiguous): your message to peer, "hi",\n   was not delivered.\n   That name exists in more than one namespace.\n   Send again with to_namespace set to one of them.',
    ],
  ])("tells the sending session when its mail is %o", async (update, text) => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    await sentPending(h);
    h.toDaemon({ id: "u1", type: "receipt_update", msg_id: ID, ...update });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({ ref: "A" });
    expect(notify.mock.calls[0][1]).toBe(text);
    expect(notify.mock.calls[0][2]).toBe(ID);
    // Told once: a repeated update is an unknown msg_id.
    h.toDaemon({ id: "u2", type: "receipt_update", msg_id: ID, ...update });
    await new Promise((r) => setTimeout(r, 50));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each(["claude-code", "opencode", "pi"] as const)(
    "quotes a long, messy body in the %s sender's notice",
    async (kind) => {
      const notify = vi.fn<NotifyFn>(async () => true);
      const h = await daemonHarness({
        notifiers: { [kind]: notify },
        sentFile: sentFile(),
      });
      await sentPending(
        h,
        kind,
        'Can you\n regenerate the "API" ref\x1b[31m erence for the docs site?',
      );
      h.toDaemon({
        id: "u1",
        type: "receipt_update",
        msg_id: ID,
        state: "expired",
      });
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(notify.mock.calls[0][1]).toBe(
        `×  Expired: your message to peer, "Can you regenerate the 'API' ref erence…",\n   was not taken within 1 hour.`,
      );
    },
  );

  it("stays silent on delivered and on an unknown msg_id", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    await sentPending(h);
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "delivered",
    });
    h.toDaemon({
      id: "u2",
      type: "receipt_update",
      msg_id: "mmmmmmmmmmmmmmm9",
      state: "expired",
    });
    // Nothing follows delivered: a later expiry is no notice either.
    h.toDaemon({
      id: "u3",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it("still tells the sender after a daemon restart", async () => {
    const file = sentFile();
    const h1 = await daemonHarness({ sentFile: file });
    await sentPending(h1);
    await stopAll();
    const notify = vi.fn<NotifyFn>(async () => true);
    const h2 = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: file,
    });
    await h2.adapter("A");
    h2.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
      reason: "recipient_closed",
    });
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "A" }),
        '×  Expired: your message to peer, "hi",\n   was not delivered because peer closed first.',
        ID,
      ),
    );
  });

  it("records nothing for a send refused at once", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    const a = await h.adapter("A");
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    h.toDaemon({
      id: sent.id,
      type: "receipt",
      msg_id: ID,
      state: "refused",
      reason: "unknown_agent",
    });
    await reply;
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it("tells the sender once it is back when the update beats its reconnect after a restart", async () => {
    const file = sentFile();
    const h1 = await daemonHarness({ sentFile: file });
    await sentPending(h1);
    await stopAll();
    const notify = vi.fn<NotifyFn>(async () => true);
    const h2 = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: file,
    });
    h2.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
      reason: "recipient_closed",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
    await h2.adapter("A");
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "A" }),
        '×  Expired: your message to peer, "hi",\n   was not delivered because peer closed first.',
        ID,
      ),
    );
    // Told: a later reconnect does not repeat it.
    await h2.adapter("A");
    await new Promise((r) => setTimeout(r, 50));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("answers the waiting send when receipt_update arrives before the receipt, and sends no notice", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    const a = await h.adapter("A");
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
    });
    h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
    await expect(reply).resolves.toMatchObject({
      type: "receipt",
      msg_id: ID,
      state: "expired",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it("retries an owed notice for a live sender every 30 s until told", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const notify = vi
        .fn<NotifyFn>()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      // A pi sender: the fake sync ticks would close a claude-code one with no session file.
      const h = await daemonHarness({
        notifiers: { pi: notify },
        sentFile: sentFile(),
      });
      await sentPending(h, "pi");
      h.toDaemon({
        id: "u1",
        type: "receipt_update",
        msg_id: ID,
        state: "expired",
      });
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(notify).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
