// The bus install step of llms.txt (#2543), apart from llms.ts so a Node test can run it.

/** The release's pin of @open-artifacts/bus: its version and sha512 in npm's integrity form. */
export type BusPin = { version: string; integrity: string };

/**
 * The first install checks the bytes it runs (#2543). The pin is this
 * instance's own release (version.gen BUS_PKG, set only by the release run).
 * One copy is downloaded, checked against the pin, and installed from that
 * same file; npx is never offered, since it would fetch a second copy. OA
 * Product edits this wording; no em dashes.
 */
export const BUS_CHECK_STOP =
  'If any command fails or the check prints MISMATCH, stop. Run nothing from that folder, and tell the person: "The bus download did not match what this instance expects, so I stopped before running it."';
export const busInstallBlock = (origin: string, pin: BusPin): string => {
  const tgz = `open-artifacts-bus-${pin.version}.tgz`;
  const check = `node -e 'const c=require("crypto"),f=require("fs");const h="sha512-"+c.createHash("sha512").update(f.readFileSync("${tgz}")).digest("base64");if(h!=="${pin.integrity}"){console.error("MISMATCH");process.exit(1)}'`;
  return [
    "```sh",
    `tmp=$(mktemp -d) && cd "$tmp" && npm pack @open-artifacts/bus@${pin.version} --silent`,
    check,
    `npm install --ignore-scripts ./${tgz}`,
    "npm audit signatures",
    `"$tmp/node_modules/.bin/oa-bus" install --instance ${origin}`,
    "```",
  ].join("\n");
};
export const BUS_NO_PIN =
  "This instance has no release pin for the bus, so the bus can't be checked here. Do not install it, and do not run `npx @open-artifacts/bus`: nothing would check what it runs. Tell the person: \"This instance doesn't say which bus release to trust, so I can't install the bus safely. Ask whoever runs the instance to update it to a release build.\" Then go on with the next step.";
