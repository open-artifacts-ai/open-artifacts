// oa-canary-hold <word> <n>: the canary's slow tool call (agy S7). It marks
// itself started, then waits for the harness to write its release file: on
// a file event, never a timer loop. Released: prints "released", exits 0. No
// release within CANARY_HOLD_MS (default 300 s): writes a timedout marker the
// harness fails the check on, prints "timed out", exits 1.
import { existsSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const [word = "", n = ""] = process.argv.slice(2);
const dir = process.env.CANARY_SIGNALS ?? "";
if (!/^[a-z0-9]{1,32}$/.test(word) || !/^[12]$/.test(n) || !dir) {
  console.log("usage: oa-canary-hold <word> <1|2>");
  process.exit(2);
}
const f = join(dir, `hold-${word}-${n}`);
const ms = Number(process.env.CANARY_HOLD_MS) || 300_000;
/** @param {number} code @param {string} line */
const end = (code, line) => {
  watcher.close();
  clearTimeout(timer);
  console.log(line);
  process.exit(code);
};
const check = () => {
  if (existsSync(`${f}.release`)) end(0, "released");
};
// Watching starts before "started" is written, so no release is missed.
const watcher = watch(dir, check);
const timer = setTimeout(() => {
  writeFileSync(`${f}.timedout`, "");
  end(1, "timed out");
}, ms);
writeFileSync(`${f}.started`, "");
check();
