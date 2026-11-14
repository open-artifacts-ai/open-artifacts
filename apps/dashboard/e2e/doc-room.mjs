// A local stand-in for the server's doc room (#1100): y-websocket compatible
// (y-protocols sync and awareness over binary frames) on any path, one shared
// Y.Doc seeded from a small Markdown sample.
//
//   OA_DOC_PORT=1235 node e2e/doc-room.mjs [--fakes]
//
// --fakes (or OA_DOC_FAKES=1) also injects two people and one agent as remote
// collaborators with fixed cursors, for screenshots. Prints "ready <port>"
// once listening. --too-large answers every client edit with the error frame
// {"type":"error","code":"doc_too_large"} instead of applying it. --blank starts
// with an empty doc (a New doc). --full sends the same error frame to every
// client as it connects (a doc already at its limit).
// Wire spec frames (artifact UkN5r8hpoXu9DYxG): --hello role[:reason[:bytes]]
// sends the hello frame first (read:room_full, read:access:1950000, edit);
// --close <code> closes every connection with that code, --close-first <code>
// only the first that settles (--revoke: 4403, then refuse every upgrade), i.e. is still open and the newest 600 ms after it connected (4401 4403 4404 1007 1013). It logs "conn n" for
// each connection and "closing <code>" for each close it makes, each with a
// millisecond timestamp. --saved n[:name[:auto]] and
// --restored from:version send the version broadcasts. Dashboard side: VITE_MOCK=1 VITE_DOC_WS=ws://localhost:<port>.
import { docToYXmlFragment, markdownToDoc } from "@oa/doc-schema";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const SYNC = 0;
const AWARENESS = 1;

export const SAMPLE = `# Launch plan

We ship the new landing page on **Thursday**. The plan has three parts: copy, design and rollout. Read the [brief](https://example.com/brief) first.

## Checklist

- [x] Final copy reviewed
- [ ] Hero image exported
- [ ] Analytics events checked

## Rollout

Start with ten percent of visitors, watch the error rate for an hour, then go to everyone. If anything looks off we roll back with \`git revert\` and write it up here.
`;

export function startDocRoom({
  port,
  fakes = false,
  tooLarge = false,
  blank = false,
  full = false,
  hello = null,
  close = null,
  closeFirst = null,
  revoke = false,
  expireAuth = false,
  saved = null,
  restored = null,
}) {
  let connections = 0;
  let closedFirst = false;
  const ydoc = new Y.Doc();
  if (!blank) {
    const { doc } = markdownToDoc(SAMPLE);
    docToYXmlFragment(doc, ydoc.getXmlFragment("default"));
  }
  const awareness = new awarenessProtocol.Awareness(ydoc);
  awareness.setLocalState(null);
  const conns = new Map(); // ws -> Set of awareness client ids it controls
  // "doc changed" per change a client's update made (a test can tell whether
  // a click sent anything).
  ydoc.on("update", (_u, origin) => {
    if (conns.has(origin)) console.log(`doc changed ${Date.now()}`);
  });
  const send = (ws, bytes) => {
    if (ws.readyState === 1) ws.send(bytes);
  };

  ydoc.on("update", (update, origin) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const ws of conns.keys()) if (ws !== origin) send(ws, msg);
  });
  awareness.on("update", ({ added, updated, removed }, origin) => {
    const owned = conns.get(origin);
    if (owned) {
      for (const id of added) owned.add(id);
      for (const id of removed) owned.delete(id);
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [
        ...added,
        ...updated,
        ...removed,
      ]),
    );
    const msg = encoding.toUint8Array(enc);
    for (const ws of conns.keys()) send(ws, msg);
  });

  // --revoke: access is gone after the first 4403, so later upgrades are
  // refused with 404, as #2490's route does (a browser sees a 1006 close).
  let revoked = false;
  // --expire-auth: the first settled socket closes 4401 (TTL) and the session
  // is gone, so later upgrades are refused 401, as the route does.
  let expired = false;
  // stdin "login": the viewer signed in again, so upgrades are accepted.
  process.stdin.on("data", (d) => {
    if (String(d).split("\n").includes("login")) {
      expired = false;
      console.log(`logged in ${Date.now()}`);
    }
  });
  const wss = new WebSocketServer({
    port,
    verifyClient: (_info, cb) => {
      const status = revoked ? 404 : expired ? 401 : 0;
      if (!status) return cb(true);
      // A log line per refused upgrade, so a test can tell the client stopped.
      console.log(`refused ${status} ${Date.now()}`);
      cb(false, status);
    },
  });
  wss.on("connection", (ws) => {
    connections++;
    // A log line per connection, so a test can tell a NEW socket opened.
    console.log(`conn ${connections} ${Date.now()}`);
    // The wire spec's hello frame comes first, before any sync frame.
    if (hello) {
      const [role, reason, bytes] = hello.split(":");
      ws.send(
        JSON.stringify({
          type: "hello",
          role,
          ...(reason ? { reason } : {}),
          bytes: Number(bytes) || 1024,
          cap: 2097152,
          version: 1,
        }),
      );
    }
    // --saved n[:name[:auto]] and --restored from:version: the room's version
    // broadcasts, 1.2 s after a client connects (the page has loaded by then).
    if (saved) {
      const [n, name, auto] = saved.split(":");
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              type: "saved",
              version: Number(n),
              ...(name ? { name } : {}),
              auto: auto === "auto",
            }),
          ),
        1200,
      );
    }
    if (restored) {
      const [from, version] = restored.split(":");
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              type: "restored",
              from: Number(from),
              version: Number(version),
            }),
          ),
        1200,
      );
    }
    // --close <code>: every connection is closed with that code (4403, 4404,
    // 1007, 1013 ...); --close-first <code>: only the first one is.
    // --close-first closes the first connection that SETTLES (still open
    // after 200 ms), so a React StrictMode socket that is torn down at once
    // never counts, and the test sees whether the client reconnects.
    const mine = connections;
    setTimeout(() => {
      // Still open, and still the newest: a StrictMode socket the page has
      // torn down (or is tearing down) is neither.
      if (ws.readyState !== 1 || mine !== connections) return;
      const code =
        close ??
        (!closedFirst
          ? revoke
            ? "4403"
            : expireAuth
              ? "4401"
              : closeFirst
          : null);
      if (!code) return;
      if (close === null) closedFirst = true;
      if (revoke) revoked = true;
      if (expireAuth) expired = true;
      console.log(`closing ${code} ${Date.now()}`);
      ws.close(Number(code), "wire spec");
    }, 600);
    conns.set(ws, new Set());
    ws.binaryType = "arraybuffer";
    ws.on("message", (data) => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      switch (decoding.readVarUint(decoder)) {
        case SYNC: {
          // peek: the sync message type (2 is a client update).
          if (tooLarge && decoding.peekVarUint(decoder) === 2) {
            ws.send(JSON.stringify({ type: "error", code: "doc_too_large" }));
            break;
          }
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, SYNC);
          syncProtocol.readSyncMessage(decoder, enc, ydoc, ws);
          if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
          break;
        }
        case AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            decoding.readVarUint8Array(decoder),
            ws,
          );
          break;
      }
    });
    ws.on("close", () => {
      const owned = conns.get(ws);
      conns.delete(ws);
      if (owned?.size)
        awarenessProtocol.removeAwarenessStates(awareness, [...owned], null);
    });
    // --full: this doc is at its limit; say so as soon as a client is here.
    if (full)
      setTimeout(
        () => ws.send(JSON.stringify({ type: "error", code: "doc_too_large" })),
        150,
      );
    // Hello: our sync step 1 (so the client sends what we lack), then the
    // current awareness states.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    send(ws, encoding.toUint8Array(enc));
    const states = [...awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, AWARENESS);
      encoding.writeVarUint8Array(
        a,
        awarenessProtocol.encodeAwarenessUpdate(awareness, states),
      );
      send(ws, encoding.toUint8Array(a));
    }
  });

  let timer;
  if (fakes) {
    // Cursor positions are Yjs relative positions inside a block's text.
    const fragment = ydoc.getXmlFragment("default");
    const blocks = fragment
      .toArray()
      .filter(
        (n) => n instanceof Y.XmlElement && n.firstChild instanceof Y.XmlText,
      );
    const at = (block, index) => {
      const text = blocks[block].firstChild;
      return Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, index),
      );
    };
    const people = [
      {
        user: { name: "Maya Chen", color: "#c2410c", kind: "user" },
        // A caret in the first paragraph, after "ship the new".
        cursor: { anchor: at(1, 17), head: at(1, 17) },
      },
      {
        user: { name: "Sam Okafor", color: "#15803d", kind: "user" },
        // A selection in the rollout paragraph.
        cursor: {
          anchor: at(blocks.length - 1, 6),
          head: at(blocks.length - 1, 31),
        },
      },
      {
        user: { name: "Docs agent", color: "#9333ea", kind: "agent" },
        // A caret at the end of the first heading.
        cursor: { anchor: at(0, 11), head: at(0, 11) },
      },
    ];
    const fakeAwareness = people.map((p) => {
      const a = new awarenessProtocol.Awareness(new Y.Doc());
      a.setLocalState(p);
      return a;
    });
    const renew = () => {
      for (const a of fakeAwareness) {
        // Bump the clock so the server's 30 s timeout never removes them.
        a.setLocalState({ ...a.getLocalState() });
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          awarenessProtocol.encodeAwarenessUpdate(a, [a.clientID]),
          "fake",
        );
      }
    };
    renew();
    timer = setInterval(renew, 5000);
  }

  return {
    ydoc,
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        for (const ws of conns.keys()) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

// Run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.OA_DOC_PORT) || 1235;
  const fakes =
    process.argv.includes("--fakes") || process.env.OA_DOC_FAKES === "1";
  const tooLarge = process.argv.includes("--too-large");
  const blank = process.argv.includes("--blank");
  const full = process.argv.includes("--full");
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const room = startDocRoom({
    port,
    fakes,
    tooLarge,
    blank,
    full,
    // The real room always says hello first (#2490); --hello none: no hello.
    hello: ((h) => (h === "none" ? null : h))(arg("--hello") ?? "edit"),
    close: arg("--close"),
    closeFirst: arg("--close-first"),
    revoke: process.argv.includes("--revoke"),
    expireAuth: process.argv.includes("--expire-auth"),
    saved: arg("--saved"),
    restored: arg("--restored"),
  });
  const stop = () => room.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(`ready ${port}`);
}
