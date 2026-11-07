# Open Artifacts

Open Artifacts is an open-source, self-hosted platform for publishing and sharing AI-generated artifacts, running on Cloudflare Workers.

Bring the pages, documents, code and PDFs your AI agents create into one library. Open them in your browser, keep their versions and choose who can access them.

![Design mockup of the Open Artifacts library, showing document, poll, PDF and code previews with agent and visibility labels.](apps/landing/public/shots/library-light-1280.webp)

*Library design mockup with synthetic example content. This is an illustration of the interface, not a capture of the current release.*

## What can you do?

- **Publish work from your agent:** turn an HTML page, Markdown document, source file or PDF into a link you can open and share.
- **Keep working at the same link:** publish changes to the same artifact and keep earlier versions to view or restore.
- **Choose your audience:** share with people as viewers or editors, with your team, or through a public link.
- **Build live pages:** HTML artifacts can use shared data for polls, checklists and other interactive tools. See the [examples](https://open-artifacts.com/#demo-h) and [runtime API](https://open-artifacts.com/docs/runtime-api/).

![Design mockup of a Markdown artifact open in the browser, with its content on the left and version history on the right.](apps/landing/public/shots/artifact-light-1280.webp)

*Viewer design mockup with synthetic example content. The version panel illustrates how work can continue beyond the first publish; controls and layout may differ in the current release.*

<details>
<summary>See the sharing interface</summary>

![Design mockup of the sharing dialog, showing private, team and public visibility and viewer or editor roles.](apps/landing/public/shots/share-light-1280.webp)

*Sharing design mockup with fictional people and example addresses. This is not a capture of an account or the current release.*

</details>

## Get started

1. **Set up your own instance:** follow the [setup guide](https://open-artifacts.com/docs/setup/). It lists prerequisites and walks your agent through installation.
2. **Connect an agent:** follow [Connect agents](https://open-artifacts.com/docs/connect-agents/) for your client. If you already have an instance, start here.
3. **Publish your first page:** ask the connected agent, “Publish a simple project checklist as an HTML artifact.” Open the link it returns. Then ask, “Add another item to that same artifact.” The link stays the same and the new publish adds a version.

For publishing inputs and supported formats, see [MCP tools](https://open-artifacts.com/docs/mcp-tools/). For access controls and HTML isolation, see the [security model](https://open-artifacts.com/docs/security/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules and [`docs/`](docs/) for repository design documentation.

Source: https://github.com/open-artifacts-ai/open-artifacts. Design docs live in [`docs/`](docs/).
User docs live at apps/landing/src/content/docs/ (open-artifacts.com/docs/).

## Managed hosting

The managed hosting code (provisioning, deploy and release workflows for the hosted service) now lives in https://github.com/open-artifacts-ai/open-artifacts-cloud. This repository stays the complete self-hostable product.
