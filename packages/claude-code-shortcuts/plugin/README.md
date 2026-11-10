# Open Artifacts session shortcuts

An optional Claude Code mod for the **CLI** and **Claude Desktop's Code tab**. After a successful Open Artifacts publish, it keeps the artifact's title, ordinary viewer link and published version above the prompt. `/oa-artifacts` shows up to ten session references, with full titles and separately checked versions.

The plugin uses your existing Open Artifacts MCP connection. It adds no MCP server, authentication, Bus connection, tool permission or background network request. It does not support ordinary Claude Chat or add a Codex integration.

## Load and configure

Use a Claude Code version with the [public Mods API](https://code.claude.com/docs/en/plugins/mods). This plugin was exercised with CLI 2.1.319 and Desktop Code 2.1.317; the prototype used these versions too.

For the CLI, load this directory for one session:

```sh
claude --plugin-dir /absolute/path/to/open-artifacts/packages/claude-code-shortcuts/plugin
```

Run `/plugin configure open-artifacts-shortcuts@inline` and set:

- **instanceUrl:** your instance's HTTPS origin or `/mcp` URL, such as `https://oa-artifacts.example.com/mcp`. Local development may use `http://localhost:8787/mcp`.
- **mcpServer:** the namespace in your actual `mcp__<namespace>__publish_artifact` tool name. The default is `open-artifacts`; use your existing connection's namespace when it differs.

The plugin stays out of the band until configured and a publish succeeds. `/oa-artifacts` explains missing configuration. These values contain no token.

For **Desktop Code**, use the [official project-local plugin loader](https://code.claude.com/docs/en/plugins/loading): place this plugin directory under your project's `.claude/skills/open-artifacts-shortcuts`, open that project in the Code tab, and use `/reload-plugins`. This loader identifies the plugin as `open-artifacts-shortcuts@skills-dir`.

The tested Desktop version routes `/plugin` to its graphical plugin manager, which does not list these project-local mods for configuration. Configure it from a terminal in that project instead:

```sh
claude plugin configure open-artifacts-shortcuts@skills-dir --values-stdin <<'JSON'
{"instanceUrl":"https://oa-artifacts.example.com/mcp","mcpServer":"open-artifacts"}
JSON
```

Replace both example values with your existing connection. The host saves these non-secret options in **user** settings; project `settings.json` and `settings.local.json` are not sources for plugin options. Restart the session or reload its plugin after configuring it. The same existing project MCP connection is used. Do not pass CLI `--plugin-dir` or isolation flags to `claude --desktop`; that launcher does not accept them.

Respect organization policy and the host's trust prompts. A policy that withholds a mod or command is not bypassed by this integration. The plugin does not depend on `classic.SessionStart`.

## Session and version behavior

- References belong to the actual current session ID and configured instance. A new session or `/clear` starts empty. Resuming the same session, or reloading its plugin, reads that session's references again. Switching sessions during a publish never attributes the result to the new session.
- Ten distinct artifacts are retained per session/instance, ordered by successful publication. Repeated publishes update the reference. The band shows at most three, within its available rows; `/oa-artifacts` shows the full stored list. Existing band content is retained, and the plugin does not request keyboard focus.
- **Published v3** means a successful content publish in this session returned v3. It is not a claim that v3 is still the service's current version. A successful `get_artifact` through the configured connection may update **Last checked: v4 at …** separately. There is no polling or automatic read. Settings-only `publish_artifact` calls create no version and do not add shortcuts.
- A successful `delete_artifact` through the configured connection removes that artifact's reference. The plugin keeps the dropped reference in its store, so a successful `undelete_artifact` for the same id in the same session puts it back. Only a successful result counts, never the tool input.
- Failed/denied publishes, malformed receipts and foreign/signed URLs are ignored. Store or drawing failures do not repeat or change the tool call. Links are limited to the configured origin's ordinary `/a/<id>` URLs, so the viewer still enforces its own sign-in and sharing rules.

The host's per-plugin store contains only IDs, titles, viewer URLs, versions and observation times. It contains no artifact bodies or credentials. These are local presentation references, not permissions, unread-comment counts or editing presence. A store error may leave an older reference visible; use a real service read before relying on its current version. Multiple processes concurrently writing the *same session* are not an atomic distributed history; the plugin serializes writes within one loaded host.

## Development checks

From the repository root:

```sh
pnpm --filter @oa/claude-code-shortcuts test
pnpm --filter @oa/claude-code-shortcuts typecheck
claude plugin validate --strict packages/claude-code-shortcuts/plugin
```

Synthetic tests exercise receipts, failures, configuration, concurrent completions, clear/resume/reload transitions and the native element contract. They are not screenshots or proof of real-client UI behavior. See the [real-client validation record](../test/real-client-validation.md) for the separately exercised CLI and Desktop behavior and remaining gaps.
