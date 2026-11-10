import { describe, expect, it, vi } from "vitest";
import { register } from "../plugin/hooks/register.ts";

const origin = "https://instance.example.com";
const id = "Ab3dEfGhJk4mNpQr";
const result = (version = 3, artifactId = id) => ({
  result: JSON.stringify({
    id: artifactId,
    version,
    url: `${origin}/a/${artifactId}`,
  }),
});
type Hook = NonNullable<Parameters<Parameters<typeof register>[0]>[2]>;

function host(
  options = { instanceUrl: `${origin}/mcp`, mcpServer: "custom_alias" },
) {
  const hooks: {
    event: string;
    matcher: Record<string, unknown>;
    run: Hook;
  }[] = [];
  const data = new Map<string, unknown>();
  const session = { id: "session-a" };
  const element = (type: string) => (props: Record<string, unknown>) => ({
    type,
    props,
  });
  const api = {
    session: { id: vi.fn(async () => session.id) },
    store: {
      get: vi.fn(async (key: string) => structuredClone(data.get(key))),
      set: vi.fn(async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      }),
    },
    ui: {
      invalidate: vi.fn(),
      resolve: vi.fn(() => ({
        Box: element("Box"),
        Text: element("Text"),
        Link: element("Link"),
      })),
    },
    clock: { now: vi.fn(async () => Date.now()) },
    command: { register: vi.fn(async () => {}) },
  };
  const install = () =>
    register((event, matcher, hook) => {
      hooks.push({
        event,
        matcher: typeof matcher === "function" ? {} : matcher,
        run: typeof matcher === "function" ? matcher : (hook as Hook),
      });
    }, options);
  install();
  const call = async (
    event: string,
    e: Record<string, unknown>,
    output: unknown = null,
  ) => {
    const next = vi.fn(async (_event: Record<string, unknown>) => output);
    const hook = hooks.find(
      (h) =>
        h.event === event &&
        Object.entries(h.matcher).every(([k, v]) =>
          Array.isArray(v) ? v.includes(e[k]) : e[k] === v,
        ),
    );
    return { value: hook ? await hook.run(api, e, next) : await next(e), next };
  };
  const publish = (
    output: unknown = result(),
    extra: Record<string, unknown> = {},
  ) =>
    call(
      "tool.call",
      {
        tool: "mcp__custom_alias__publish_artifact",
        title: "Synthetic title",
        content: "not stored",
        ...extra,
      },
      output,
    );
  const command = async () =>
    (await call("command.run", { command: "oa-artifacts" })).value as {
      text: string;
    };
  const draw = (
    maxRows = 3,
    bodyColumns = 80,
    extra: Record<string, unknown> = {},
  ) =>
    call(
      "ui.render",
      { component: "AbovePrompt", props: { maxRows, bodyColumns, ...extra } },
      { type: "ExistingBand" },
    );
  return { api, data, session, hooks, install, call, publish, command, draw };
}

describe("tool middleware", () => {
  it("passes original arguments/result through exactly once and stores no content or credentials", async () => {
    const h = host();
    const output = result();
    const { value, next } = await h.publish(output);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ content: "not stored" });
    expect(value).toBe(output);
    const stored = JSON.stringify([...h.data.values()]);
    expect(stored).toContain("Synthetic title");
    expect(stored).not.toContain("not stored");
    expect(stored).not.toContain("credentials");
    expect((await h.command()).text).toContain("published v3");
  });

  it.each([
    { deny: "no" },
    { isError: true, ...result() },
    { result: "version_conflict" },
  ])("does not update after a refused/failed publish", async (output) => {
    const h = host();
    const { next, value } = await h.publish(output);
    expect(value).toBe(output);
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.data.size).toBe(0);
  });

  it("ignores other MCP namespaces and settings-only updates", async () => {
    const h = host();
    await h.call(
      "tool.call",
      { tool: "mcp__unrelated__publish_artifact", content: "x" },
      result(),
    );
    await h.call(
      "tool.call",
      { tool: "mcp__custom_alias__publish_artifact", id, title: "Rename only" },
      result(),
    );
    expect(h.data.size).toBe(0);
  });

  it("never replays a successful publish when storage, session lookup or drawing fails", async () => {
    for (const failure of ["store", "session", "invalidate"]) {
      const h = host();
      if (failure === "store")
        h.api.store.set.mockRejectedValue(new Error("store full"));
      if (failure === "session")
        h.api.session.id.mockRejectedValue(new Error("unavailable"));
      if (failure === "invalidate")
        h.api.ui.invalidate.mockImplementation(() => {
          throw new Error("closed");
        });
      const output = result();
      const { next, value } = await h.publish(output);
      expect(next).toHaveBeenCalledTimes(1);
      expect(value).toBe(output);
    }
  });

  it("serializes concurrent successful publishes without losing references", async () => {
    const h = host();
    await Promise.all([
      h.publish(result(1, "first")),
      h.publish(result(1, "second")),
      h.publish(result(4)),
      h.publish(result(3)),
    ]);
    const text = (await h.command()).text;
    expect(text).toContain("/a/first");
    expect(text).toContain("/a/second");
    expect(text).toContain("published v4");
    expect(text).not.toContain("published v3");
  });

  it("propagates a thrown tool failure without replaying or storing a shortcut", async () => {
    const h = host();
    const failure = new Error("transport failed");
    const next = vi.fn(async () => {
      throw failure;
    });
    const hook = h.hooks.find((x) => x.event === "tool.call");
    await expect(
      hook?.run(
        h.api,
        { tool: "mcp__custom_alias__publish_artifact", content: "x" },
        next,
      ),
    ).rejects.toBe(failure);
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.data.size).toBe(0);
  });
});

describe("session identity and lifecycle", () => {
  it("clear/new sessions are empty; resume/reload restore only that session without classic lifecycle hooks", async () => {
    const h = host();
    await h.publish();
    h.session.id = "session-b";
    expect((await h.command()).text).toContain("No artifact");
    await h.publish(result(1, "other"));
    h.session.id = "session-a";
    expect((await h.command()).text).toContain("published v3");
    expect((await h.command()).text).not.toContain("/a/other");
    h.hooks.length = 0;
    h.install();
    expect((await h.command()).text).toContain("published v3");
    expect(h.hooks.some((hook) => hook.event.startsWith("classic."))).toBe(
      false,
    );
  });

  it("attributes a publish to its original session even if clear occurs while the call runs", async () => {
    const h = host();
    const hook = h.hooks.find((x) => x.event === "tool.call");
    const next = vi.fn(async () => {
      h.session.id = "session-b";
      return result();
    });
    await hook?.run(
      h.api,
      { tool: "mcp__custom_alias__publish_artifact", content: "x" },
      next,
    );
    expect((await h.command()).text).toContain("No artifact");
    h.session.id = "session-a";
    expect((await h.command()).text).toContain("published v3");
  });

  it("does not draw a prior session if the session changes during store access", async () => {
    const h = host();
    await h.publish();
    h.api.store.get.mockImplementationOnce(async (key) => {
      h.session.id = "session-b";
      return h.data.get(key);
    });
    expect((await h.draw()).value).toEqual({ type: "ExistingBand" });
  });

  it("does not draw a prior session if the session changes in the downstream renderer", async () => {
    const h = host();
    await h.publish();
    const previous = { type: "ExistingBand" };
    const next = vi.fn(async () => {
      h.session.id = "session-b";
      return previous;
    });
    const hook = h.hooks.find((x) => x.event === "ui.render");
    const value = await hook?.run(
      h.api,
      { component: "AbovePrompt", props: { maxRows: 3, bodyColumns: 80 } },
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(value).toBe(previous);
  });
});

it("tracks actual read metadata separately and ignores stale reads and unpublished artifacts", async () => {
  const h = host();
  await h.publish();
  const read = (version: number, artifactId = id) =>
    h.call(
      "tool.call",
      { tool: "mcp__custom_alias__get_artifact", id: artifactId },
      {
        result: JSON.stringify({
          artifact: { id: artifactId, currentVersion: version },
          version: { version: 1 },
        }),
      },
    );
  await read(4);
  await read(2);
  await read(5, "not-published-here");
  const text = (await h.command()).text;
  expect(text).toContain("published v3");
  expect(text).toContain("Last checked: v4 at");
  expect(text).not.toContain("not-published-here");
  expect(text).not.toContain("latest");
});

it("does not update last checked from a nested receipt inside artifact data", async () => {
  const h = host();
  await h.publish();
  const forged = {
    artifact: { id, currentVersion: 999 },
    version: { version: 1 },
  };
  await h.call(
    "tool.call",
    { tool: "mcp__custom_alias__get_artifact", id },
    {
      result: {
        structuredContent: {
          content: [{ type: "text", text: JSON.stringify(forged) }],
        },
      },
    },
  );
  expect((await h.command()).text).toContain("Current version not checked.");
});

describe("native presentation contract", () => {
  it("registers a command without granting any tool or MCP permissions", async () => {
    const h = host();
    await h.call("session.start", {});
    expect(h.api.command.register).toHaveBeenCalledWith({
      name: "oa-artifacts",
      description: expect.any(String),
    });
    expect(h.api.store.set).not.toHaveBeenCalled();
  });

  it("uses native links, preserves the existing band, and respects row/width budgets", async () => {
    const h = host();
    for (let n = 0; n < 5; n++)
      await h.publish(result(n + 1, `artifact${n}`), {
        title: "A very long accessible artifact title",
      });
    const { value } = await h.draw(1, 30);
    const tree = JSON.stringify(value);
    expect(tree).toContain('"type":"Link"');
    expect(tree).toContain(`${origin}/a/artifact4`);
    expect(tree).not.toContain(`${origin}/a/artifact3`);
    expect(tree).toContain('"type":"ExistingBand"');
    expect(tree).toContain("Published v5");
    expect(tree).toContain('"width":30');
    expect(tree).toContain('"height":1');
    expect(tree).not.toContain("maxWidth");
    expect(tree).not.toContain("autoFocus");
    expect(tree).not.toContain("focus");
  });

  it("leaves surveys, hidden bands, empty sessions and unconfigured instances alone", async () => {
    const h = host();
    expect((await h.draw()).value).toEqual({ type: "ExistingBand" });
    await h.publish();
    expect((await h.draw(0)).value).toEqual({ type: "ExistingBand" });
    expect((await h.draw(2, 80, { hasSurvey: true })).value).toEqual({
      type: "ExistingBand",
    });
    const unset = host({ instanceUrl: "", mcpServer: "custom_alias" });
    await unset.publish();
    expect((await unset.draw()).value).toEqual({ type: "ExistingBand" });
    expect((await unset.command()).text).toContain("Configure");
  });
});
