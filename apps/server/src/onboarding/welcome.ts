// The Welcome artifact a new hosted instance is seeded with (#2287). One file
// the Frontend replaces: keep the export, `origin` is this instance's origin.

export const WELCOME_TITLE = "Welcome";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function welcomeHtml(origin: string): string {
  const o = esc(origin);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${WELCOME_TITLE}</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #5c5c5c; --line: #e2e2e2; --card: #f6f6f6; }
@media (prefers-color-scheme: dark) { :root { --bg: #151515; --fg: #f0f0f0; --muted: #a8a8a8; --line: #333; --card: #1f1f1f; } }
body { margin: 0; padding: 32px 20px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 640px; margin: 0 auto; }
h1 { font-size: 28px; margin: 0 0 16px; }
code { display: block; padding: 12px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow-wrap: anywhere; font: 14px/1.5 ui-monospace, monospace; }
ul { list-style: none; padding: 0; margin: 24px 0; }
li { padding: 10px 0; border-bottom: 1px solid var(--line); }
li::before { content: "\\2610"; margin-right: 10px; color: var(--muted); }
p.note { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>Welcome to Open Artifacts</h1>
<p>Paste this to your agent:</p>
<code>Set up Open Artifacts for me: follow ${o}/llms.txt</code>
<ul>
<li>Connect your agent</li>
<li>Publish your first artifact</li>
<li>Comment on it</li>
</ul>
<p class="note">Select this sentence and leave a comment to try comments here.</p>
</main>
</body>
</html>
`;
}
