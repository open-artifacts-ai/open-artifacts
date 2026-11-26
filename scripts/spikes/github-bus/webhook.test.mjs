import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { receive, recipients } from "./webhook.mjs";

const recordings = JSON.parse(
  await readFile(
    new URL("./fixtures/recordings.json", import.meta.url),
    "utf8",
  ),
);
const key = await crypto.subtle.generateKey(
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
);
const delivery = "63436160-2ee6-4259-86f0-35c1b9c9a8a0";
const encoder = new TextEncoder();
const bytesOf = (body) => encoder.encode(JSON.stringify(body));

// Three public captures are repository webhooks and omit installation. Where requested,
// layer the App installation field onto a copy; preserve all captured check/run values.
function setup(name, appEnvelope = true) {
  const body = structuredClone(recordings[name].body);
  if (appEnvelope) body.installation ??= { id: 1 };
  const binding = {
    repositoryId: body.repository.id,
    repository: body.repository.full_name,
    installationId: 1,
    writers: new Set([body.sender.id]),
  };
  const seenIds = new Set();
  const seenBodies = new Set();
  const events = [];
  function accept({ delivery, bodyHash }, event) {
    if (seenIds.has(delivery) || seenBodies.has(bodyHash)) return false;
    seenIds.add(delivery);
    seenBodies.add(bodyHash);
    events.push(event);
    return true;
  }
  async function request(bytes = bytesOf(body)) {
    const raw = await crypto.subtle.sign("HMAC", key, bytes);
    const hex = Array.from(new Uint8Array(raw), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
    return {
      bytes,
      key,
      binding,
      accept,
      headers: new Headers({
        "x-github-delivery": delivery,
        "x-github-event": name.split("/")[0],
        "x-hub-signature-256": `sha256=${hex}`,
      }),
    };
  }
  const follow = {
    repositoryId: binding.repositoryId,
    installationId: 1,
    recipient: "leo/feature",
  };
  return { body, binding, events, request, follow };
}

for (const [name, expected] of [
  ["check_run/completed", "success"],
  ["check_suite/completed", "success"],
  ["workflow_run/completed", "success"],
  ["merge_group/checks_requested", "checks_requested"],
  ["pull_request_review/submitted", "commented"],
  ["pull_request/synchronize", "synchronize"],
  ["pull_request/closed", "closed"],
]) {
  test(`recording: ${name}`, async () => {
    const f = setup(name);
    assert.equal(await receive(await f.request()), 202);
    assert.equal(f.events.length, 1);
    const event = f.events[0];
    assert.equal(event.result, expected);
    assert.equal(event.repositoryId, f.binding.repositoryId);
    assert.equal(event.source, "github");
    assert.ok(
      event.url.startsWith(`https://github.com/${f.binding.repository}/`),
    );
    assert.ok(event.text.includes("GitHub event (information only)"));
  });
}

test("signature covers exact bytes before parsing", async () => {
  const f = setup("pull_request_review/submitted");
  const req = await f.request();
  assert.equal(
    await receive({
      ...req,
      bytes: encoder.encode(` ${new TextDecoder().decode(req.bytes)}`),
    }),
    401,
  );
  req.headers.delete("x-hub-signature-256");
  assert.equal(await receive(req), 401);
  req.headers.set("x-hub-signature-256", "sha256=abc");
  assert.equal(await receive(req), 401);
  const invalidJson = await f.request(encoder.encode("{"));
  assert.equal(await receive(invalidJson), 400);
  invalidJson.headers.delete("x-hub-signature-256");
  assert.equal(await receive(invalidJson), 401);
  assert.deepEqual(f.events, []);
});

test("oversized body and malformed delivery id produce no event", async () => {
  const f = setup("pull_request/synchronize");
  const req = await f.request();
  assert.equal(
    await receive({ ...req, bytes: new Uint8Array(1024 * 1024 + 1) }),
    413,
  );
  req.headers.set("x-github-delivery", "invalid");
  assert.equal(await receive(req), 400);
  assert.deepEqual(f.events, []);
});

test("concurrent redelivery emits once; a new header ID cannot repeat a signed body", async () => {
  const f = setup("pull_request_review/submitted");
  const req = await f.request();
  await Promise.all([receive(req), receive(req)]);
  req.headers.set("x-github-delivery", "11111111-eeee-4444-8888-222222222222");
  assert.equal(await receive(req), 202);
  assert.equal(f.events.length, 1);
});

test("an unavailable sink cannot acknowledge a delivery; a retry succeeds", async () => {
  const f = setup("pull_request/synchronize");
  const req = await f.request();
  await assert.rejects(
    receive({
      ...req,
      accept: async () => {
        throw Error("offline");
      },
    }),
    /offline/,
  );
  assert.equal(await receive(req), 202);
  assert.equal(f.events.length, 1);
});

test("rejects missing installation, another repo, an outsider and a fork", async () => {
  const repoHook = setup("check_run/completed", false);
  assert.equal(await receive(await repoHook.request()), 204);
  for (const change of [
    (b) => {
      b.installation.id = 43;
    },
    (b) => {
      b.repository.id++;
    },
    (b) => {
      b.sender.id++;
    },
    (b) => {
      b.pull_request.head.repo.id++;
    },
  ]) {
    const f = setup("pull_request_review/submitted");
    change(f.body);
    assert.equal(await receive(await f.request()), 204);
    assert.deepEqual(f.events, []);
  }
});

test("review text and URLs are excluded; each matching recipient gets one event", async () => {
  const f = setup("pull_request_review/submitted");
  f.body.review.body = "untrusted review prose";
  f.body.review.html_url = "https://example.org/other";
  await receive(await f.request());
  const [event] = f.events;
  assert.equal(
    event.url,
    "https://github.com/Codertocat/Hello-World/pull/2#pullrequestreview-237895671",
  );
  assert.doesNotMatch(JSON.stringify(event), /untrusted|example\.org/);
  const match = { ...f.follow, pr: 2 };
  assert.deepEqual(
    recipients(event, [
      match,
      match,
      { ...match, repositoryId: 9, recipient: "other" },
      { ...match, installationId: 9, recipient: "elsewhere" },
      { ...match, pr: 3, recipient: "unrelated" },
    ]),
    ["leo/feature"],
  );
});

test("a completed check wakes only a PR follower at the checked head", async () => {
  const f = setup("check_run/completed");
  await receive(await f.request());
  const current = { ...f.follow, pr: 2, headSha: f.body.check_run.head_sha };
  assert.deepEqual(
    recipients(f.events[0], [
      current,
      { ...current, headSha: "a".repeat(40), recipient: "stale" },
    ]),
    ["leo/feature"],
  );
});

test("a failed run with no PR wakes workflow followers, including failure-only follows", async () => {
  const f = setup("workflow_run/completed");
  const run = f.body.workflow_run;
  const follow = { ...f.follow, workflow: run.workflow_id, result: "failure" };
  await receive(await f.request());
  assert.deepEqual(recipients(f.events[0], [follow]), []);
  run.conclusion = "failure";
  run.run_attempt++;
  const req = await f.request();
  req.headers.set("x-github-delivery", "77777777-dddd-4321-8123-555555555555");
  await receive(req);
  const failed = f.events[1];
  assert.equal(failed.attempt, 2);
  assert.deepEqual(failed.prs, []);
  assert.deepEqual(
    recipients(failed, [
      follow,
      { ...f.follow, pr: 2 },
      { ...follow, workflow: 44 },
    ]),
    ["leo/feature"],
  );
  run.triggering_actor.id++;
  assert.equal(await receive(await f.request()), 204);
});

test("per-PR queue exit, closure and merge use distinct fixed labels", async () => {
  for (const [action, merged, result] of [
    ["enqueued", false, "enqueued"],
    ["dequeued", false, "dequeued"],
    ["closed", false, "closed"],
    ["closed", true, "merged"],
  ]) {
    const f = setup("pull_request/closed");
    Object.assign(f.body, { action, reason: "raw reason is private" });
    f.body.pull_request.merged = merged;
    await receive(await f.request());
    assert.equal(f.events[0].result, result);
    assert.doesNotMatch(f.events[0].text, /raw reason/);
  }
});

test("group destruction never guesses PR membership or yields a per-PR merge", async () => {
  for (const reason of ["invalidated", "dequeued", "merged", "unknown"]) {
    const f = setup("merge_group/checks_requested");
    Object.assign(f.body, { action: "destroyed", reason });
    await receive(await f.request());
    const [event] = f.events;
    assert.deepEqual(event.prs, []);
    assert.equal(event.kind, "merge_group");
    assert.equal(event.result, reason === "unknown" ? "destroyed" : reason);
    const follow = { ...f.follow, pr: 104 };
    assert.deepEqual(recipients(event, [follow]), []);
    assert.deepEqual(recipients(event, [{ ...follow, groupSha: event.sha }]), [
      "leo/feature",
    ]);
  }
});

// A local bus consumer acknowledges the message so the test waits on delivery itself.
test("a signed review reaches the subscribed agent's local inbox", async () => {
  const f = setup("pull_request_review/submitted");
  const follows = [
    { ...f.follow, pr: 2 },
    { ...f.follow, pr: 19, recipient: "leo/release" },
  ];
  const inbox = [];
  const request = await f.request();
  const wired = {
    ...request,
    accept: async (keys, event) => {
      if (!request.accept(keys, event)) return;
      for (const to of recipients(event, follows))
        inbox.push({ to, text: event.text });
    },
  };
  assert.deepEqual(
    await Promise.all([receive(wired), receive(wired)]),
    [202, 202],
  );
  assert.deepEqual(inbox, [
    {
      to: "leo/feature",
      text: "GitHub event (information only) · Codertocat/Hello-World · PR #2 · review commented at ec26c3e5. https://github.com/Codertocat/Hello-World/pull/2#pullrequestreview-237895671",
    },
  ]);
});
