// Offline spike. The caller supplies the verified repository binding and an atomic sink.
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "skipped",
  "startup_failure",
]);
const isId = (id) => Number.isSafeInteger(id) && id > 0;
const isSha = (value) => typeof value === "string" && SHA.test(value);

function normalize(type, body, binding) {
  const repoId = binding.repositoryId;
  const url = `https://github.com/${binding.repository}`;
  const { action, pull_request: pr } = body;
  if (type === "pull_request" || type === "pull_request_review") {
    if (
      !isId(pr?.number) ||
      pr.base?.repo?.id !== repoId ||
      pr.head?.repo?.id !== repoId ||
      !isSha(pr.head.sha)
    )
      return;
    const number = pr.number;
    const link = `${url}/pull/${number}`;
    if (type === "pull_request_review") {
      const review = body.review;
      if (
        action !== "submitted" ||
        !isId(review?.id) ||
        !isSha(review.commit_id)
      )
        return;
      const result =
        typeof review.state === "string" ? review.state.toLowerCase() : "";
      if (!["approved", "changes_requested", "commented"].includes(result))
        return;
      return {
        kind: "review",
        prs: [number],
        sha: review.commit_id,
        result,
        url: `${link}#pullrequestreview-${review.id}`,
      };
    }
    if (body.number !== number) return;
    if (
      ![
        "opened",
        "reopened",
        "synchronize",
        "enqueued",
        "dequeued",
        "closed",
      ].includes(action)
    )
      return;
    if (action === "closed" && typeof pr.merged !== "boolean") return;
    return {
      kind: "pr",
      prs: [number],
      sha: pr.head.sha,
      result: action === "closed" && pr.merged ? "merged" : action,
      url: link,
    };
  }
  if (type === "merge_group") {
    const group = body.merge_group;
    if (!isSha(group?.head_sha) || !isSha(group.base_sha)) return;
    if (!["checks_requested", "destroyed"].includes(action)) return;
    const result =
      action === "checks_requested"
        ? action
        : ["merged", "dequeued", "invalidated"].includes(body.reason)
          ? body.reason
          : "destroyed";
    return {
      kind: "merge_group",
      prs: [],
      sha: group.head_sha,
      result,
      url: `${url}/commit/${group.head_sha}`,
    };
  }
  if (!["check_run", "check_suite", "workflow_run"].includes(type)) return;
  const run = body[type];
  if (
    action !== "completed" ||
    run?.status !== "completed" ||
    !isId(run.id) ||
    !isSha(run.head_sha) ||
    !CONCLUSIONS.has(run.conclusion) ||
    !Array.isArray(run.pull_requests)
  )
    return;
  const prs = run.pull_requests
    .filter(
      (p) =>
        isId(p?.number) &&
        p.head?.repo?.id === repoId &&
        p.base?.repo?.id === repoId &&
        p.head.sha === run.head_sha,
    )
    .map((p) => p.number);
  if (type === "workflow_run") {
    if (
      !isId(run.workflow_id) ||
      !isId(run.run_attempt) ||
      run.head_repository?.id !== repoId ||
      !binding.writers.has(run.actor?.id) ||
      !binding.writers.has(run.triggering_actor?.id)
    )
      return;
    // A base-branch workflow can have an untrusted fork as its PR origin.
    if (run.event === "pull_request_target") return;
    if (run.event === "pull_request" && !prs.length) return;
    return {
      kind: type,
      prs,
      sha: run.head_sha,
      result: run.conclusion,
      workflow: run.workflow_id,
      run: run.id,
      attempt: run.run_attempt,
      url: `${url}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
    };
  }
  return {
    kind: type,
    prs,
    sha: run.head_sha,
    result: run.conclusion,
    check: run.id,
    url: `${url}/commit/${run.head_sha}/checks`,
  };
}

// Follows are pre-authorized snapshots. Recipient is a member-scoped stable agent identity.
export function recipients(event, follows) {
  const matches = follows.filter((f) => {
    if (
      f.installationId !== event.installationId ||
      f.repositoryId !== event.repositoryId
    )
      return false;
    if (f.workflow !== undefined)
      return (
        f.workflow === event.workflow &&
        (!f.result || f.result === event.result)
      );
    if (event.kind === "merge_group")
      return isId(f.pr) && f.groupSha === event.sha;
    if (!event.prs.includes(f.pr)) return false;
    return ["pr", "review"].includes(event.kind) || f.headSha === event.sha;
  });
  return [...new Set(matches.map((f) => f.recipient))];
}

export async function receive({ bytes, headers, key, binding, accept }) {
  if (bytes.byteLength > 1024 * 1024) return 413;
  const match = /^sha256=([0-9a-f]{64})$/.exec(
    headers.get("x-hub-signature-256") ?? "",
  );
  if (!match) return 401;
  const signature = Uint8Array.from(match[1].match(/../g), (hex) =>
    Number.parseInt(hex, 16),
  );
  if (!(await crypto.subtle.verify("HMAC", key, signature, bytes))) return 401;
  const delivery = headers.get("x-github-delivery");
  if (!UUID.test(delivery ?? "")) return 400;
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return 400;
  }
  if (
    !isId(binding.installationId) ||
    !isId(binding.repositoryId) ||
    body?.installation?.id !== binding.installationId ||
    body.repository?.id !== binding.repositoryId ||
    body.repository?.full_name !== binding.repository ||
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository) ||
    !isId(body.sender?.id) ||
    !binding.writers.has(body.sender.id)
  )
    return 204;
  const event = normalize(headers.get("x-github-event"), body, binding);
  if (!event) return 204;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const bodyHash = Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const subject =
    event.kind === "pr" || event.kind === "review"
      ? `PR #${event.prs[0]} · `
      : "";
  const text = `GitHub event (information only) · ${binding.repository} · ${subject}${event.kind} ${event.result} at ${event.sha.slice(0, 8)}. ${event.url}`;
  await accept(
    { delivery, bodyHash },
    {
      source: "github",
      repository: binding.repository,
      installationId: binding.installationId,
      repositoryId: binding.repositoryId,
      text,
      ...event,
    },
  );
  return 202;
}
