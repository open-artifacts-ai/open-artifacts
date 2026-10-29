// The capture extension's Google classifier (also unit-tested from
// test/oneshot.test.ts). It turns a top-level IdP page URL into the only
// thing the script ever learns about Google pages: whether it is the
// sign-in page or a block page, and the hd hint. The URL, path and query
// (which carry sign-in state) never leave the extension.
self.OA_classify = (url, idp, blockPatterns) => {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== idp) return null;
  const block = blockPatterns.some((p) => new RegExp(p, "i").test(u.pathname));
  const raw = u.searchParams.get("hd");
  const hd = raw && /^[a-z0-9.-]{1,253}$/i.test(raw) ? raw.toLowerCase() : null;
  return { google: block ? "block" : "signin", hd };
};
