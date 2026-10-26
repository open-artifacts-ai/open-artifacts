---
title: Runtime API
description: Let HTML artifacts save and read data with window.openArtifacts.
order: 4
---

An HTML artifact can keep data with `window.openArtifacts`. Polls, trackers, and checklists all work this way. The data belongs to the artifact, not a version, so a new version sees the same data.

## Ready and theme

`openArtifacts.ready` is a promise that resolves once the viewer shell has connected; wait for it before your first call. Outside the viewer, with no shell, it resolves at once.

`openArtifacts.theme` is `"light"` or `"dark"`. It starts from the viewer's system setting and follows the shell's theme once it connects. `onTheme(callback)` calls back whenever it changes and returns a function that stops listening.

```js
await openArtifacts.ready;
document.documentElement.dataset.theme = openArtifacts.theme;
openArtifacts.onTheme((t) => (document.documentElement.dataset.theme = t));
```

## Capabilities

An artifact declares what it uses when it's published, for example `capabilities: { db: true, viewer: true }`. Calls to anything it didn't declare are rejected.

| Capability | Gives the page |
|---|---|
| `db` | Shared data that every viewer sees |
| `viewer` | Who is viewing |
| `storage` | Private data for each viewer |

## Shared data: `db`

`db.collection(name)` returns a collection with:

- `get(id)` to read one document, or `null`
- `list({ cursor, limit })` and `query(filter)` to read many. Each returns a page, `{ items, nextCursor }`; pass `nextCursor` back as `cursor` for the next page.
- `set(id, doc)`, `update(id, patch)`, and `delete(id)` to write
- `subscribe(callback)` for live updates when anyone changes the collection. It returns a function that unsubscribes.

Each document is `{ id, data, updatedAt, updatedBy }`, with your value in `data`.

Each `subscribe` callback gets `{ docs, deleted }`: the documents that changed and the ids of those deleted. If the live connection drops and reconnects, changes may have been missed, so the callback gets `{ docs: [], deleted: [], resync: true }` instead. On `resync`, refetch with `list()` or `query()`.

If the live connection is refused or keeps failing, the callback gets `{ docs: [], deleted: [], offline: true }`, once per outage: live changes are paused. Tell the viewer (for example, "Live updates paused. Reload to retry."). When the connection comes back, the callback gets `resync`.

```js
const votes = openArtifacts.db.collection("votes");
const all = new Map();
const refetch = async () => {
  showPaused(false);
  all.clear();
  for (const doc of (await votes.list()).items) all.set(doc.id, doc);
  render([...all.values()]);
};
votes.subscribe((e) => {
  if (e.offline) return showPaused(true);
  if (e.resync) return refetch();
  for (const doc of e.docs) all.set(doc.id, doc);
  for (const id of e.deleted) all.delete(id);
  render([...all.values()]);
});
await refetch();
await votes.set(crypto.randomUUID(), { option: "Lisbon" });
```

## The viewer: `viewer`

`viewer.get()` returns `{ email, name }`, or `null` for an anonymous viewer of a public artifact.

`viewer.anonId()` returns an anonymous viewer's id on an artifact that allows anonymous writes, and `null` otherwise (signed-in viewers included).

### Anonymous ids

On an artifact that allows anonymous writes, each anonymous browser gets an id from `viewer.anonId()`, so a game or poll can tell two anonymous players apart. Their documents carry `updatedBy: "anon:<anonId>"`. Only documents written before anonymous ids existed still say `"anon"`.

- It belongs to one browser on one device. Another browser or device gets a different id, and clearing site data resets it.
- Each artifact sees a different id for the same browser, so ids can't be matched across artifacts.
- It is not a person or an account, so don't treat it as proof of who someone is.
- It is signed by the server: no one can forge someone else's id, but anyone can reset their own.
- It is only issued on artifacts that allow anonymous writes. Signed-in viewers never get one.

An `anonId` is a label, not a permission. Any anonymous viewer can still overwrite or delete any document, so use it to show who did what (for example, a seat claimed by `anonId`) and expect conflicts.

## Per-viewer data: `storage`

`storage` keeps documents keyed to the current viewer, such as which boxes they ticked, with `get(key)`, `set(key, value)`, `delete(key)`, and `list()`, which returns the viewer's keys.

## Who can write

- Signed-in viewers who can see the artifact can read and write.
- Anonymous viewers of a public artifact can read. They can write only if the publisher turned on `allowAnonymousWrites`, and those writes are rate-limited per IP address.

## Limits

| Limit | Default |
|---|---|
| Document size (Workers Free) | {LIMIT_DATA_DOC_FREE} |
| Document size (Workers Paid) | {LIMIT_DATA_DOC_PAID} |
| Data per artifact | {LIMIT_ARTIFACT_DATA} |
| Writes per viewer | {LIMIT_VIEWER_WRITES} |
| Anonymous writes per IP | {LIMIT_ANON_WRITES} |

## Errors

Every call returns a promise. A failed call rejects with an error that has a `code` and a `message`:

| `code` | Meaning |
|---|---|
| `no_shell` | No viewer shell to reach the server. Outside the viewer (for example, the artifact's file opened directly), every call fails at once; in a frame, a call fails if no shell has answered within a few seconds. |
| `capability_denied` | The artifact didn't declare that capability, or the viewer isn't allowed (for example, an anonymous write). |
| `bad_request` | Invalid parameters, such as a bad collection name or a value that can't be sent. |
| `rate_limited`, `too_large`, `quota_exceeded` | A limit was reached. |
| `not_found`, `unauthorized`, `conflict`, `internal` | Other server errors. |

Handle `no_shell` by showing the page without live data:

```js
try {
  render(await openArtifacts.db.collection("votes").list());
} catch (e) {
  if (e.code === "no_shell") showStatic();
  else throw e;
}
```

## How it works

The artifact runs in a sandboxed iframe with no credentials. Each call goes by `postMessage` to the viewer shell around it, which checks the call and makes it with the viewer's session. Opened outside the viewer, the artifact has no shell, so every call rejects at once with `no_shell`.

Live data works on the page the viewer first opens. If the artifact navigates its own frame to another page, for example through a link to another of its files, calls on that page fail with `no_shell`, and reloading the viewer restores them. If a multi-page artifact needs live data, switch views within one page instead of linking between files.

Links: open them with `target="_blank" rel="noopener"`. They open in a new tab: external sites as normal pages, and the artifact's own files in the viewer. A link without a target loads inside the artifact's frame, where live data stops and most external sites refuse to load; `target="_top"` does nothing, because an artifact can't navigate the viewer page.
