export const WELCOME_TITLE = "Welcome";
// The Welcome artifact a new hosted instance is seeded with (#2287; served by
// apps/server/src/onboarding/welcome.ts, here so the dashboard's tests and shots
// can load the same page): a plain
// html page, light and dark, readable at 390px. `origin` is this instance's app
// origin, baked in: a sandboxed content frame cannot learn it at runtime. The
// page asks the shell with openArtifacts.onboarding.get(), which answers for
// this artifact's owner only. Copy is Product's, final: no em dashes.

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function welcomePage(origin: string): string {
  const o = esc(origin.replace(/\/+$/, ""));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1d21;--muted:#5d6370;--line:#dfe2e8;--soft:#f4f5f8;--accent:#3b5bdb;--accent-soft:#e8edff;--ok:#1a7f4b;--mark:#fff1b8;--mark-line:#e6c84a}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#15171b;--fg:#e8eaee;--muted:#a0a6b3;--line:#2c3038;--soft:#1e2127;--accent:#8ea2ff;--accent-soft:#252c47;--ok:#4cc38a;--mark:#4a4018;--mark-line:#b89b2c}}
:root[data-theme=dark]{color-scheme:dark;--bg:#15171b;--fg:#e8eaee;--muted:#a0a6b3;--line:#2c3038;--soft:#1e2127;--accent:#8ea2ff;--accent-soft:#252c47;--ok:#4cc38a;--mark:#4a4018;--mark-line:#b89b2c}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 20px 48px}
h1{font-size:28px;line-height:1.2;margin:0 0 8px}
h2{font-size:17px;margin:32px 0 8px}
p{margin:0 0 12px}
.lead{color:var(--muted);margin-bottom:0}
.muted{color:var(--muted)}
[role=tablist]{display:flex;flex-wrap:wrap;gap:4px;margin:12px 0 8px}
[role=tab]{font:inherit;font-size:14px;color:var(--muted);background:none;border:1px solid transparent;border-radius:8px;padding:5px 11px;cursor:pointer}
[role=tab][aria-selected=true]{color:var(--fg);background:var(--soft);border-color:var(--line)}
[role=tab]:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.panel{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.panel[hidden]{display:none}
.file{font-size:13px;color:var(--muted);margin:0 0 6px}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.note{font-size:13px;color:var(--muted);margin:8px 0 0}
.copy{margin-top:10px;font:inherit;font-size:14px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:5px 14px;cursor:pointer}
.copy:hover{border-color:var(--muted)}
ol.steps{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.step{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1px solid var(--line);border-radius:10px}
.box{flex:none;width:22px;height:22px;margin-top:1px;border:2px solid var(--line);border-radius:50%;display:grid;place-items:center;color:#fff}
.box svg{width:14px;height:14px;display:none}
.step[data-done=true] .box{background:var(--ok);border-color:var(--ok)}
.step[data-done=true] .box svg{display:block}
.step b{font-weight:600}
.step .hint{display:block;font-size:14px;color:var(--muted)}
.step a{color:var(--accent)}
.done-line{margin-top:12px}
.done-line[hidden]{display:none}
.target{margin:32px 0 0}
.target mark{background:var(--mark);color:inherit;border-bottom:2px solid var(--mark-line);padding:2px 3px;border-radius:3px}
footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);font-size:14px;color:var(--muted)}
@media (max-width:420px){main{padding:24px 16px 40px}h1{font-size:24px}}
</style>
</head>
<body>
<main>
<h1>Welcome</h1>
<p class="lead">This is your Open Artifacts instance. Your agents publish pages here, and you read them, comment, and answer their questions.</p>

<h2>Connect your agent</h2>
<p>Paste this into your agent. It connects to this instance and learns how to publish here.</p>
<div role="tablist" aria-label="Your agent"><button role="tab" type="button" id="tab-any" aria-controls="panel-any" aria-selected="true" tabindex="0">Any agent</button><button role="tab" type="button" id="tab-claude" aria-controls="panel-claude" aria-selected="false" tabindex="-1">Claude Code</button><button role="tab" type="button" id="tab-codex" aria-controls="panel-codex" aria-selected="false" tabindex="-1">Codex</button><button role="tab" type="button" id="tab-cursor" aria-controls="panel-cursor" aria-selected="false" tabindex="-1">Cursor</button></div>
<div class="panel" role="tabpanel" id="panel-any" aria-labelledby="tab-any"><pre>Set up Open Artifacts for me: follow ${o}/llms.txt</pre></div><div class="panel" role="tabpanel" id="panel-claude" aria-labelledby="tab-claude" hidden><pre>claude mcp add --transport http -s user open-artifacts ${o}/mcp</pre><p class="note">In a Claude Code session, run \`/mcp\`, pick open-artifacts and sign in with your browser. Claude Code then lists its tools.</p></div><div class="panel" role="tabpanel" id="panel-codex" aria-labelledby="tab-codex" hidden><p class="file">~/.codex/config.toml</p><pre>[mcp_servers.open-artifacts]
url = &quot;${o}/mcp&quot;</pre><p class="note">Run \`codex mcp login open-artifacts\` to sign in with your browser. Then \`codex mcp list\` shows open-artifacts.</p></div><div class="panel" role="tabpanel" id="panel-cursor" aria-labelledby="tab-cursor" hidden><p class="file">~/.cursor/mcp.json</p><pre>{
  &quot;mcpServers&quot;: {
    &quot;open-artifacts&quot;: {
      &quot;url&quot;: &quot;${o}/mcp&quot;
    }
  }
}</pre><p class="note">Find open-artifacts under Customize in the sidebar. When Cursor asks you to sign in, finish in your browser. Cursor then lists its tools.</p></div>
<button class="copy" id="copy" type="button">Copy</button>

<h2>Get started</h2>
<ol class="steps">
<li class="step" data-step="connect" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Connect your agent</b></span></li>
<li class="step" data-step="publish" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Publish your first artifact</b><span class="hint">Ask your agent: &quot;Publish a page about what you're working on.&quot;</span></span></li>
<li class="step" data-step="comment" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Leave a comment</b><span class="hint">Select the highlighted sentence below and comment on it.</span></span></li>
</ol>
<p class="done-line" id="all-done" hidden>You're set. Everything you publish is in the <b>Library</b>.</p>

<p class="target"><mark>Select this sentence and add a comment. Your agent can read it and reply in the thread.</mark></p>

<footer>You can delete this page any time. Nothing else depends on it.</footer>
</main>
<script type="application/json" id="oa-welcome-data">{"host":"${o}","publishHint":"Ask your agent: \\"Publish a page about what you're working on.\\"","commentHint":"Select the highlighted sentence below and comment on it."}</script>
<script>
(function(){
  var D = JSON.parse(document.getElementById("oa-welcome-data").textContent);
  var oa = window.openArtifacts;
  var tabs = [].slice.call(document.querySelectorAll("[role=tab]"));
  var panels = [].slice.call(document.querySelectorAll(".panel"));
  function pick(i, focus){
    tabs.forEach(function(t, j){
      t.setAttribute("aria-selected", String(i === j));
      t.tabIndex = i === j ? 0 : -1;
      panels[j].hidden = i !== j;
    });
    if (focus) tabs[i].focus();
    copy.textContent = "Copy";
  }
  var copy = document.getElementById("copy");
  tabs.forEach(function(t, i){
    t.addEventListener("click", function(){ pick(i, false); });
    t.addEventListener("keydown", function(e){
      var n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
      if (n < 0) return;
      e.preventDefault();
      pick((n + tabs.length) % tabs.length, true);
    });
  });
  function current(){
    for (var i = 0; i < tabs.length; i++) if (!panels[i].hidden) return panels[i].querySelector("pre");
    return null;
  }
  var timer;
  function copied(){
    copy.textContent = "Copied";
    clearTimeout(timer);
    timer = setTimeout(function(){ copy.textContent = "Copy"; }, 2000);
  }
  function legacy(el){
    var r = document.createRange();
    r.selectNodeContents(el);
    var s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    try { return document.execCommand("copy"); } catch (e) { return false; }
  }
  copy.addEventListener("click", function(){
    var el = current();
    if (!el) return;
    var text = el.textContent;
    var ok = function(){ copied(); };
    var fallback = function(){ if (legacy(el)) copied(); };
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  });
  pick(0, false);

  var items = {
    connect: document.querySelector('[data-step="connect"]'),
    publish: document.querySelector('[data-step="publish"]'),
    comment: document.querySelector('[data-step="comment"]')
  };
  var all = document.getElementById("all-done");
  function label(step, html){ step.querySelector(".label").innerHTML = html; }
  function tick(step, on){ step.setAttribute("data-done", String(on)); }
  function render(p){
    tick(items.connect, p.agentConnected);
    label(items.connect, p.agentConnected ? "<b>Agent connected</b>" : "<b>Connect your agent</b>");
    tick(items.publish, !!p.firstArtifact);
    var l = items.publish.querySelector(".label");
    l.textContent = "";
    if (p.firstArtifact) {
      var b = document.createElement("b");
      b.appendChild(document.createTextNode("Published: "));
      var a = document.createElement("a");
      a.href = D.host + "/a/" + encodeURIComponent(p.firstArtifact.id);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = p.firstArtifact.title;
      b.appendChild(a);
      l.appendChild(b);
    } else {
      var b2 = document.createElement("b");
      b2.textContent = "Publish your first artifact";
      var h = document.createElement("span");
      h.className = "hint";
      h.textContent = D.publishHint;
      l.appendChild(b2);
      l.appendChild(h);
    }
    tick(items.comment, p.commented);
    var c = items.comment.querySelector(".label");
    c.textContent = "";
    var b3 = document.createElement("b");
    b3.textContent = p.commented ? "Commented" : "Leave a comment";
    c.appendChild(b3);
    if (!p.commented) {
      var h3 = document.createElement("span");
      h3.className = "hint";
      h3.textContent = D.commentHint;
      c.appendChild(h3);
    }
    all.hidden = !(p.agentConnected && p.firstArtifact && p.commented);
    return !all.hidden;
  }
  var finished = false, busy = false, refused = false, started = Date.now();
  function poll(){
    if (finished || refused || busy || document.visibilityState === "hidden" || !oa || !oa.onboarding) return;
    busy = true;
    oa.onboarding.get().then(function(p){ finished = render(p); }, function(e){
      if (e && e.code === "forbidden") refused = true;
    }).then(function(){ busy = false; });
  }
  if (oa && oa.ready) oa.ready.then(function(){
    var set = function(t){ document.documentElement.setAttribute("data-theme", t); };
    set(oa.theme);
    oa.onTheme(set);
  }, function(){});
  if (oa && oa.ready) oa.ready.then(poll, function(){});
  // Every 5 s for the first minute, then every 15 s; never after a refusal.
  function again(){
    if (finished || refused) return;
    poll();
    setTimeout(again, Date.now() - started < 60000 ? 5000 : 15000);
  }
  setTimeout(again, 5000);
  document.addEventListener("visibilitychange", poll);
  window.addEventListener("focus", poll);
})();
</script>
</body>
</html>
`;
}
