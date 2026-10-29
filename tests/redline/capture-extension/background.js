// The red-line capture extension (docs/ops/redline-signin.md). Loaded by
// hand ("Load unpacked") into the capture's temporary Chrome profile, from
// the copy the script writes for each run (with manifest.json, rules.json
// and config.js generated for that run).
//
// - rules.json (declarativeNetRequest) blocks every top-level request to the
//   two installs' /auth/callback/google, so the browser never spends a code.
// - webRequest, observe only: when that block happens
//   (net::ERR_BLOCKED_BY_CLIENT), the URL goes to the script's 127.0.0.1
//   listener with this run's token, and the tab is closed. The script takes
//   only this prompt's host and state, once.
// - webRequest, observe only, on the IdP's top-level pages in a prompt's
//   tab: only a classification goes to the listener,
//   { prompt, google: "signin" | "block", hd }, computed here (classify.js).
//   Never a Google URL, path or query: those carry sign-in state.
// - On the script's "clear" command: the IdP's cookies and storage are
//   removed (chrome.browsingData) and the tabs this extension opened are
//   closed, before each prompt. "open" opens a URL in a new tab, tagged with
//   its prompt.
// Nothing is ever logged.
importScripts("config.js", "classify.js");
const C = self.OA_CAPTURE;

const post = (path, body) =>
  fetch(`${C.listener}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: C.token, ...body }),
  });

const opened = new Set();

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (d.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
    let u;
    try {
      u = new URL(d.url);
    } catch {
      return;
    }
    if (u.pathname !== "/auth/callback/google") return;
    post("/blocked", { url: d.url }).catch(() => {});
    if (d.tabId >= 0) {
      opened.delete(d.tabId);
      chrome.tabs.remove(d.tabId).catch(() => {});
    }
  },
  { urls: C.callbackPatterns, types: ["main_frame"] },
);

/** Each prompt tab's prompt, and the hd of the first IdP page it opened. */
const promptOf = new Map();
const hdOf = new Map();
const tell = (tabId, google) =>
  post("/google", {
    prompt: promptOf.get(tabId),
    google,
    hd: hdOf.get(tabId) ?? null,
  }).catch(() => {});

/** Classifications seen before their tab was tagged (tabs.create races its first request). */
const early = new Map();

function onRequest(tabId, c) {
  // The first IdP request of the tab is the authorize URL the script opened.
  if (!hdOf.has(tabId)) hdOf.set(tabId, c.hd);
  if (c.google === "block") tell(tabId, "block");
}
function onDone(tabId, c, status) {
  if (c.google === "signin" && status >= 200 && status < 300)
    tell(tabId, "signin");
}
function seen(d, f) {
  const c = self.OA_classify(d.url, C.idp, C.blockPatterns);
  if (!c) return;
  if (promptOf.has(d.tabId)) return f(d.tabId, c);
  // Not tagged yet: hold the classification (never the URL) briefly.
  const q = early.get(d.tabId) ?? [];
  if (q.length < 20) q.push(() => f(d.tabId, c));
  early.set(d.tabId, q);
}

chrome.webRequest.onBeforeRequest.addListener((d) => seen(d, onRequest), {
  urls: C.idpPatterns,
  types: ["main_frame"],
});
chrome.webRequest.onCompleted.addListener(
  (d) => seen(d, (tabId, c) => onDone(tabId, c, d.statusCode)),
  { urls: C.idpPatterns, types: ["main_frame"] },
);

async function run(c) {
  if (c.cmd === "clear") {
    await chrome.browsingData.remove(
      { origins: C.clearOrigins },
      {
        cookies: true,
        localStorage: true,
        indexedDB: true,
        cacheStorage: true,
        serviceWorkers: true,
        fileSystems: true,
      },
    );
    for (const id of opened) await chrome.tabs.remove(id).catch(() => {});
    opened.clear();
    promptOf.clear();
    hdOf.clear();
    early.clear();
  } else if (c.cmd === "open") {
    const t = await chrome.tabs.create({ url: c.url });
    opened.add(t.id);
    if (typeof c.prompt === "string") {
      promptOf.set(t.id, c.prompt);
      // Whatever the tab did before it was tagged, in order.
      for (const f of early.get(t.id) ?? []) f();
    }
    early.delete(t.id);
  }
}

// The script's commands, by long poll (the worker can't take connections).
async function loop() {
  for (;;) {
    let c;
    try {
      const r = await post("/next", {});
      if (!r.ok) throw new Error(String(r.status));
      c = await r.json();
    } catch {
      await new Promise((res) => setTimeout(res, 1000));
      continue;
    }
    if (!c || c.cmd === "none") continue;
    let ok = true;
    try {
      await run(c);
    } catch {
      ok = false;
    }
    await post("/ack", { id: c.id, ok }).catch(() => {});
  }
}

// Registered so the worker starts (and checks in) when Chrome starts or
// the extension is loaded.
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});
// Extension API calls keep the worker alive between long polls.
setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
post("/hello", {})
  .catch(() => {})
  .finally(loop);
