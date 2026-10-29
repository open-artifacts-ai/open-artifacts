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
// - webRequest, observe only, on the IdP's top-level pages: their URL and
//   status go to the listener (a block page stops the run; the dry run checks
//   the hd hint).
// - On the script's "clear" command: the IdP's cookies and storage are
//   removed (chrome.browsingData) and the tabs this extension opened are
//   closed, before each prompt. "open" opens a URL in a new tab.
// Nothing is ever logged.
importScripts("config.js");
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

for (const [event, phase] of [
  [chrome.webRequest.onBeforeRequest, "request"],
  [chrome.webRequest.onCompleted, "completed"],
])
  event.addListener(
    (d) => {
      post("/idp", {
        url: d.url,
        phase,
        status: typeof d.statusCode === "number" ? d.statusCode : 0,
      }).catch(() => {});
    },
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
  } else if (c.cmd === "open") {
    const t = await chrome.tabs.create({ url: c.url });
    opened.add(t.id);
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
