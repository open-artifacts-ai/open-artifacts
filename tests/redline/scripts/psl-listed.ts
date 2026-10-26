// Post-M1 verification, outside the gate (the manager's ruling on #649):
// tenant hosts under each hosted zone are different sites per the PSL
// snapshot tldts ships, private section included (as browsers read it).
//   node --experimental-strip-types scripts/psl-listed.ts [zone ...]
// Default zones: the staging and prod app and content zones. Exits 0 when
// every zone is listed, 2 when any isn't yet.
import { getDomain } from "tldts";

const ZONES = [
  "open-artifacts-staging.app",
  "open-artifacts-staging.page",
  "open-artifacts.app",
  "open-artifacts.page",
];
const zones = process.argv.slice(2).length ? process.argv.slice(2) : ZONES;
const site = (h: string) => getDomain(h, { allowPrivateDomains: true });
let unlisted = 0;
for (const z of zones) {
  const listed = site(`rl-a.${z}`) !== site(`rl-b.${z}`);
  if (!listed) unlisted++;
  console.log(`${listed ? "listed  " : "unlisted"} ${z}`);
}
process.exit(unlisted ? 2 : 0);
