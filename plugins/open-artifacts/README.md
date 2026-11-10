# Open Artifacts plugin for Claude Code

For now this plugin only offers the **Artifacts Teammate** output style. It does not yet add the Open Artifacts MCP server or skill, so installing it does not connect Claude Code to an instance. Use the setup in your instance's `/llms.txt` for that.

The style keeps replies short, sends one-line updates for background work, and puts decisions and asks on a published page. It is not switched on for you: pick it yourself.

## Install

```bash
claude plugin marketplace add open-artifacts-ai/open-artifacts
claude plugin install open-artifacts@open-artifacts
```

Then, in Claude Code, run `/output-style` and choose Artifacts Teammate. Claude Code reads styles at session start, so restart running sessions.

## Keeping the style in sync

`output-styles/artifacts-teammate.md` is a copy of `packages/bus-cli/output-style/artifacts-teammate.md`, because a plugin cannot reference files outside its folder. A test (`scripts/ci/claude-plugin.test.ts`) fails if the two differ. To change the style, edit the bus-cli file and copy it here.

The plugin version in `.claude-plugin/plugin.json` is bumped with each release by release-please.
