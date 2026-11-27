# `oa-bus status --json` schema (`v: 1`)

`oa-bus status --json` prints one JSON object on stdout with no ANSI escapes and exits `0` when `verdict === "working"` or `1` when `"degraded"` or `"down"`.

The top-level `v` field versions the schema. Any breaking change (renaming, removing, or changing the type of an existing field) must bump `v`.

## Top-level fields (`v: 1`)

| Field | Type | Description |
| --- | --- | --- |
| `v` | `1` | Schema version. |
| `version` | `string` | `oa-bus` CLI version. |
| `verdict` | `"working" \| "degraded" \| "down"` | Overall bus verdict. |
| `machine` | `string \| null` | Approved machine label, or `null` when unregistered. |
| `daemon` | `"up" \| "down" \| "stalled" \| "unregistered" \| "revoked"` | Local daemon/registration state. |
| `instances` | `Instance[]` | Configured Open Artifacts instances and their link status. |
| `folders` | `Record<string, string>` | Folder-to-instance overrides from `folders.json`. |
| `attention` | `{ problem: string; fix: string }[]` | Active problems and plain fixes (empty when healthy). |
| `project` | `Project` | Current folder's namespace summary and full agent list. |
| `other_projects` | `{ namespace: string; name: string; count: number }[]` | Other namespaces with live agents on this machine. |
| `messages` | `LateMessage[]` | Recent late deliveries, newest first. |
| `links` | `LinkSession[]` | Live Claude sessions and their link state. |
| `agents_page_url` | `string \| null` | URL to the main instance's `/settings/agents` page. |

## Nested shapes

- **`Instance`**: `{ name, host, url, main, connected, revoked, agents, guests }`
- **`Project`**: `{ namespace, named, unnamed_hidden, agents }`
  - **`Project.agents[]`**: `{ name, kind, machine, state, group, unnamed, status, status_label, status_at }`
    - `group`: `"needs_you" | "working" | "idle_old"`
- **`LateMessage`**: `{ from, to, excerpt, at, delay_ms }` (`at` is ISO-8601 UTC; `delay_ms` is `number | null`)
- **`LinkSession`**: `{ name, cwd, state, cause }` (`cause` is `string | null`)
