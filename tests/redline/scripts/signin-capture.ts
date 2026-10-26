// Starts the real-tenant sign-in flows (P5 R6, staging only).
//   REDLINE_TARGETS=... node --experimental-strip-types scripts/signin-capture.ts <dir>
// Creates <dir> (0700) with flows.json (each start's state and the install's
// state cookie) and urls.txt (the URL to open per flow, and the user to sign
// in as), both 0600. Nothing is printed but the paths. Then, within 9 minutes,
// for each flow a real tenant user completes Google sign-in in a browser and
// the callback URL is saved to <dir>/<flow>.url (0600), and the suite runs
// with REDLINE_SIGNIN_CAPTURES=<dir>. See docs/ops/redline-signin.md.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_FLOWS,
  type FlowName,
  type StartedFlow,
  startGoogle,
} from "../src/signin.ts";
import { loadTargets } from "../src/targets.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: signin-capture.ts <dir>");
  process.exit(2);
}
const T = await loadTargets();
if (T.mode !== "staging") {
  console.error("signin-capture: staging targets only");
  process.exit(2);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const flows: StartedFlow[] = [];
const urls: string[] = [];
for (const [flow, spec] of Object.entries(CAPTURE_FLOWS)) {
  const s = await startGoogle(T[spec.at]);
  if (!s) {
    console.error(
      `signin-capture: Google sign-in is off on ${T[spec.at].name}`,
    );
    process.exit(1);
  }
  flows.push({
    flow: flow as FlowName,
    at: spec.at,
    state: s.state,
    cookie: s.cookie,
    startedAt: Date.now(),
  });
  urls.push(`${flow}\t${spec.user}\t${s.location.toString()}`);
}
writeFileSync(join(dir, "flows.json"), JSON.stringify(flows), { mode: 0o600 });
writeFileSync(join(dir, "urls.txt"), `${urls.join("\n")}\n`, { mode: 0o600 });
console.log(`signin-capture: wrote ${join(dir, "flows.json")} and urls.txt`);
