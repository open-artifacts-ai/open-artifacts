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
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1d21;--muted:#5d6370;--line:#dfe2e8;--soft:#f4f5f8;--accent:#3b5bdb;--accent-soft:#e8edff;--ok:#1a7f4b}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#15171b;--fg:#e8eaee;--muted:#a0a6b3;--line:#2c3038;--soft:#1e2127;--accent:#8ea2ff;--accent-soft:#252c47;--ok:#4cc38a}}
:root[data-theme=dark]{color-scheme:dark;--bg:#15171b;--fg:#e8eaee;--muted:#a0a6b3;--line:#2c3038;--soft:#1e2127;--accent:#8ea2ff;--accent-soft:#252c47;--ok:#4cc38a}
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
.step .stalled{display:block;margin-top:6px;font-size:14px;color:var(--muted)}
.step .stalled[hidden],.step[hidden]{display:none}
.also{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}
.also[hidden],.member-done[hidden]{display:none}
.also .step{border-style:dashed}
.open{display:inline-block;margin-top:10px;font-size:14px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:5px 14px;text-decoration:none}
.open:hover{border-color:var(--muted)}
.step a.open{color:var(--fg)}
.member-done{margin-top:12px}
.count{margin:12px 0 0;font-size:14px;color:var(--muted)}
.connect-body{display:block;margin-top:10px}
.connect-body .panel{background:var(--soft)}
.connector{margin-top:16px}
.connector a{color:var(--accent)}
footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);font-size:14px;color:var(--muted)}
@media (max-width:420px){main{padding:24px 16px 40px}h1{font-size:24px}}
</style>
</head>
<body>
<main>
<h1 id="title">Welcome</h1>
<p class="lead" id="lead">This is your Open Artifacts instance. Your agents publish pages here, and you read them, comment, and answer their questions.</p>

<div id="connect-section">
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
</div>
<div class="connector" id="connector" hidden><p class="note">Using Claude or ChatGPT in a chat? Add Open Artifacts as a custom connector with this address:</p><div class="panel"><pre id="connector-url">${o}/mcp</pre></div><button class="copy" id="connector-copy" type="button">Copy</button><p class="note">Log in when it asks. Your chat sees new comments and answers only when you ask it to look.</p><p class="note"><a href="https://open-artifacts.com/docs/claude-and-chatgpt/" target="_blank" rel="noopener">How to add a connector</a></p></div>

<h2>Get started</h2>
<ol class="steps">
<li class="step" data-step="connect" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Connect your agent</b></span></li>
<li class="step" data-step="name" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Name your agent</b><span class="hint">Your agent will suggest a name. It's what you'll type after @ in comments.</span></span></li>
<li class="step" data-step="publish" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Publish your first artifact</b><span class="hint">Ask your agent: &quot;Publish a page about what you're working on.&quot;</span></span></li>
<li class="step" data-step="comment" data-done="false" hidden><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Comment on a page</b><span class="hint">Select some text on any page and leave a comment, or reply in a thread. It's how you, your team and your agents work on the same page.</span></span></li>
<li class="step" data-step="mention" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Mention your agent</b><span class="hint">Open your first page, type @ in a comment and pick your agent. It replies in the thread.</span><span class="stalled" id="stalled" role="status" hidden>No reply yet. Your agent may not be listening. Ask it: &quot;Check the bus.&quot;</span></span></li>
<li class="step" data-step="ask" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Answer your agent's ask</b><span class="hint">Your first page has a question from your agent. Pick an option.</span></span></li>
</ol>
<p class="done-line" id="all-done" hidden>You're set. Your agent hears your comments and answers them.</p>
<template id="member-tpl"><div class="member-done" id="member-done" role="status" hidden><p><b>You're set.</b></p><p id="member-done-text"></p><a class="open" href="${o}/" target="_blank" rel="noopener">Open the Library</a></div><div class="also" id="also"><ol class="steps"><li class="step" data-step="teammate" data-done="false"><span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span class="label"><b>Also try: comment on a teammate's page</b><span class="hint" id="also-hint"></span><a class="open" href="${o}/" target="_blank" rel="noopener">Open the Library</a></span></li></ol></div>
</template>

<footer>You can delete this page any time. Nothing else depends on it.</footer>
</main>
<script type="application/json" id="oa-welcome-data">{"host":"${o}","publishHint":"Ask your agent: \\"Publish a page about what you're working on.\\"","commentHint":"Select some text on any page and leave a comment, or reply in a thread. It's how you, your team and your agents work on the same page.","nameHint":"Your agent will suggest a name. It's what you'll type after @ in comments.","mentionHint":"Open your first page, type @ in a comment and pick {name}. It replies in the thread.","askHint":"Your first page has a question from {name}. Pick an option.","fallback":"your agent","member":{"welcome":"Welcome, {first}","lead":"{inviter} added you to {org}. {steps} steps and your agent is working here with you.","leadNoInviter":"{steps} steps and your agent is working here with you.","connectHint":"Paste the line below into your agent.","publishHint":"Your agent publishes one during setup. It's private until you share it.","mentionHint":"Open your first page, type @ in a comment and pick your agent. It replies in the thread.","askHint":"Your first page has a question from your agent. Pick an option.","alsoHint":"See what {org} is working on and leave a comment.","count":"{n} of {t} done","done":"Your agent hears your comments and answers them. Next: see what {org} is working on."}}</script>
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
  var connCopy = document.getElementById("connector-copy");
  connCopy.addEventListener("click", function(){
    var el = document.getElementById("connector-url");
    var done = function(){
      connCopy.textContent = "Copied";
      setTimeout(function(){ connCopy.textContent = "Copy"; }, 2000);
    };
    var fallback = function(){ if (legacy(el)) done(); };
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(el.textContent).then(done, fallback);
    else fallback();
  });
  pick(0, false);

  var items = {};
  ["connect","name","publish","comment","mention","ask"].forEach(function(k){
    items[k] = document.querySelector('[data-step="' + k + '"]');
  });
  var all = document.getElementById("all-done");
  var stalled = document.getElementById("stalled");
  stalled.parentNode.removeChild(stalled);
  function tick(step, on){ step.setAttribute("data-done", String(on)); }
  // One step: its label is the done line when done, else the title and hint.
  function line(step, done, title, doneText, hint){
    tick(step, done);
    var l = step.querySelector(".label");
    l.textContent = "";
    var b = document.createElement("b");
    b.textContent = done ? doneText : title;
    l.appendChild(b);
    if (!done && hint) {
      var h = document.createElement("span");
      h.className = "hint";
      h.textContent = hint;
      l.appendChild(h);
    }
    return l;
  }
  var M = D.member;
  var memberDone = null, connectBody = null, countLine = null;
  // #2632: a member's own Welcome. The shell says who it's for; the owner's
  // page is unchanged. The sixth step never counts toward "You're set."
  function greet(w, bus, cm){
    if (!memberDone) {
      var tpl = document.getElementById("member-tpl");
      all.parentNode.insertBefore(tpl.content.cloneNode(true), all.nextSibling);
      memberDone = document.getElementById("member-done");
    }
    if (!connectBody) {
      // The member's screen: the line and Copy live in step 1.
      connectBody = document.createElement("span");
      connectBody.className = "connect-body";
      connectBody.appendChild(document.getElementById("panel-any"));
      connectBody.appendChild(copy);
      var conn = document.getElementById("connector");
      conn.hidden = false;
      connectBody.appendChild(conn);
      document.getElementById("connect-section").hidden = true;
      countLine = document.createElement("p");
      countLine.className = "count";
      countLine.id = "count";
      var lead = document.getElementById("lead");
      lead.parentNode.insertBefore(countLine, lead.nextSibling);
    }
    var org = w.org || "";
    document.getElementById("title").textContent = w.firstName ? M.welcome.replace("{first}", function(){ return w.firstName; }) : "Welcome";
    var steps = ["Three", "Four", "Five", "Six"][(bus ? 2 : 0) + (cm ? 1 : 0)];
    var leadText = w.inviter ? M.lead.replace("{inviter}", function(){ return w.inviter; }).replace("{org}", function(){ return org; }) : M.leadNoInviter;
    document.getElementById("lead").textContent = leadText.replace("{steps}", steps);
    document.getElementById("also-hint").textContent = M.alsoHint.replace("{org}", function(){ return org; });
    document.getElementById("member-done-text").textContent = M.done.replace("{org}", function(){ return org; });
    tick(document.querySelector('[data-step="teammate"]'), !!w.teammateCommented);
  }
  function render(p){
    var w = p.who && p.who.member ? p.who : null;
    // #2890: a person who never connected the bus sees three steps; an older shell sends no flag: five.
    var bus = p.busConnected !== false;
    // #2953: "Comment on a page" shows once the shell sends firstComment (null or a page); an older shell sends none.
    var cm = p.firstComment !== undefined;
    if (w) greet(w, bus, cm);
    var nm = p.agentName || D.fallback;
    items.name.hidden = !bus;
    items.mention.hidden = !bus;
    items.comment.hidden = !cm;
    var cl = line(items.connect, p.agentConnected, "Connect your agent", "Agent connected", w ? M.connectHint : "");
    // Step 1 holds the line until the agent is connected, then is its done row.
    if (w && !p.agentConnected) cl.appendChild(connectBody);
    line(items.name, !!p.agentNamed, "Name your agent", "Named: " + nm, D.nameHint);
    var l = line(items.publish, !!p.firstArtifact, "Publish your first artifact", "", w ? M.publishHint : D.publishHint);
    if (p.firstArtifact) {
      var b = l.querySelector("b");
      b.textContent = "Published: ";
      var a = document.createElement("a");
      a.href = D.host + "/a/" + encodeURIComponent(p.firstArtifact.id);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = p.firstArtifact.title;
      b.appendChild(a);
    }
    line(items.comment, !!p.firstComment, "Comment on a page", p.firstComment ? "You commented on " + p.firstComment.title + "." : "", D.commentHint);
    var ml = line(items.mention, !!p.mentionReplied, "Mention your agent", (p.agentName ? nm : "Your agent") + " replied", w ? M.mentionHint : D.mentionHint.replace("{name}", function(){ return nm; }));
    line(items.ask, !!p.askAnswered, "Answer your agent's ask", "Answered", w ? M.askHint : D.askHint.replace("{name}", function(){ return nm; }));
    stalled.hidden = !(p.mentionStalled && !p.mentionReplied);
    if (!stalled.hidden) ml.appendChild(stalled);
    var done = !!(p.agentConnected && p.firstArtifact && p.askAnswered && (!cm || p.firstComment) && (!bus || (p.agentNamed && p.mentionReplied)));
    all.hidden = !done || !!w;
    if (w) {
      memberDone.hidden = !done;
      // The shell's setupSteps count (one count everywhere); an older shell's answer counts here.
      var n = typeof w.doneAll === "number" ? w.doneAll : typeof w.done === "number" && !cm ? w.done : (bus ? [p.agentConnected, p.agentNamed, p.firstArtifact, cm && p.firstComment, p.mentionReplied, p.askAnswered] : [p.agentConnected, p.firstArtifact, cm && p.firstComment, p.askAnswered]).filter(Boolean).length;
      countLine.textContent = M.count.replace("{n}", function(){ return String(n); }).replace("{t}", String((bus ? 5 : 3) + (cm ? 1 : 0)));
    }
    // A member keeps polling for the optional sixth step until it's done too.
    return done && (!w || !!w.teammateCommented);
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
