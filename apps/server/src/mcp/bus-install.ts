// The bus install step of llms.txt (#2543), apart from llms.ts so a Node test
// can run it. OA Product edits this wording; no em dashes.

/** The release's pin of @open-artifacts/bus: its version and sha512 in npm's integrity form. */
export type BusPin = { version: string; integrity: string };

/**
 * The first install runs only the bytes it checked: one install from the
 * registry into a temp folder, the lockfile checked against the pin before
 * anything runs, npm's own signature audit, then the installer run by node
 * from that folder. npx is never offered, since it would fetch another copy.
 */
export const BUS_CHECK_STOP =
  'If the check prints MISMATCH, stop. Run nothing from that folder, and tell the person: "The bus download did not match what this instance expects, so I stopped before running it." If another command fails, stop too, and tell the person which command failed and what it printed. Don\'t try another way to install.';

export const busInstallBlock = (
  origin: string,
  pin: BusPin,
  /** What the checked copy runs; the installer by default. */
  command = `install --instance ${origin}`,
): string => {
  const check = `node -e 'const l=require("./package-lock.json").packages||{};const k=Object.keys(l).filter(x=>x!=="");const p=l["node_modules/@open-artifacts/bus"];const ok=k.length===1&&p&&p.version==="${pin.version}"&&p.integrity==="${pin.integrity}";process.stdout.write((ok?"OK":"MISMATCH")+"\\n");process.exit(ok?0:1)'`;
  // One command: every step is chained with &&, so a failed install, check or
  // audit can never reach the installer line.
  return [
    "```sh",
    'tmp=$(mktemp -d) && cd "$tmp" &&',
    `npm install --ignore-scripts --registry https://registry.npmjs.org @open-artifacts/bus@${pin.version} &&`,
    `${check} &&`,
    "npm audit signatures &&",
    `node "$tmp/node_modules/@open-artifacts/bus/dist/index.js" ${command}`,
    "```",
  ].join("\n");
};

/** Build facts that go into the text: printable ASCII only, short. */
export const cleanWhy = (s: string): string =>
  s
    .replace(/[^A-Za-z0-9 .,:;@/()+_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

/**
 * This build has no verified pin: no install line at all, only why. A person
 * who runs the instance fixes it by deploying a build that can verify.
 */
export const busNoPin = (why: string): string =>
  `The bus can't be installed from this build of the instance: it has no verified release to check the download against (${cleanWhy(why) || "no reason recorded"}). Do not install it, and do not run \`npx @open-artifacts/bus\` or any other install command: nothing would check what it runs. Tell the person: "This instance can't give me a checked bus release, so I can't install the bus safely. Ask whoever runs the instance to deploy a release build." Then go on with the next step.`;

/**
 * The first bus release with `oa-bus skill` (#2624). An older pin has no such
 * command, so the setup file gives only the save-by-hand text for it.
 * test/node/skill-min-bus.test.ts fails if a release ships without #2624 at or
 * past this version: then move it to the next release.
 */
export const SKILL_COMMAND_MIN_BUS = "0.201.0";

/** Does the pinned bus have `oa-bus skill`? Plain x.y.z compare; anything else says no. */
export const pinHasSkillCommand = (version: string): boolean => {
  const a = version.split(".").map(Number);
  const b = SKILL_COMMAND_MIN_BUS.split(".").map(Number);
  if (a.length !== 3 || a.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number))
      return (a[i] as number) > (b[i] as number);
  }
  return true;
};
