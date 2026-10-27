// The e2e job's flaky and quarantine report (Playwright JSON reports in, GitHub
// annotations and a step summary out). Never fails the build on results:
// flaky tests passed on their retry, and quarantined tests don't gate.
//   e2e-report.ts count <mock|real>   -> how many tests that suite has in quarantine
//   e2e-report.ts summary <report dir> <quarantine dir>
//     reads <report dir>/{mock,real}.json (merged shards) and
//     <quarantine dir>/{mock,real}.json (e2e.sh quarantine); either may be missing
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadQuarantine,
  type Quarantined,
  type Suite,
  suiteOf,
} from "../../apps/dashboard/e2e/quarantine.ts";

/** A quarantined test leaves after this many straight passes (the nightly repeat). */
export const GRADUATE_RUNS = 10;
const SUITES: Suite[] = ["mock", "real"];

interface PwResult {
  status: string;
  retry: number;
}
interface PwTest {
  projectName: string;
  status: string;
  results: PwResult[];
}
interface PwSpec {
  title: string;
  file: string;
  line: number;
  tests: PwTest[];
}
interface PwSuite {
  title: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

export interface Row {
  suite: Suite;
  /** Spec path under e2e/ ("real/" prefixed for the real suite), as quarantine.json has it. */
  file: string;
  line: number;
  /** Describe titles then the test title, joined by " › ". */
  title: string;
  project: string;
  status: string;
  results: PwResult[];
}

/** Every test of one Playwright JSON report. */
export function rows(report: { suites?: PwSuite[] }, suite: Suite): Row[] {
  const out: Row[] = [];
  const walk = (s: PwSuite, path: string[]) => {
    for (const sp of s.specs ?? [])
      for (const t of sp.tests)
        out.push({
          suite,
          file: (suite === "real" ? "real/" : "") + sp.file,
          line: sp.line,
          title: [...path, sp.title].join(" › "),
          project: t.projectName,
          status: t.status,
          results: t.results,
        });
    for (const c of s.suites ?? []) walk(c, [...path, c.title]);
  };
  // The top-level suites are files: their title is the path, not a describe.
  for (const f of report.suites ?? []) walk(f, []);
  return out;
}

// GitHub workflow-command escaping (data, then property values).
const data = (s: string) =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const prop = (s: string) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const where = (r: Row) => `${r.title}${r.project ? ` [${r.project}]` : ""}`;

/** Flaky tests: failed, then passed on the retry. */
export const flaky = (all: Row[]) => all.filter((r) => r.status === "flaky");

export interface Verdict {
  q: Quarantined;
  runs: number;
  passed: number;
  /** ran >= GRADUATE_RUNS times and never failed */
  graduate: boolean;
}

/** Each quarantined test's runs and passes in the quarantine reports. */
export function verdicts(entries: Quarantined[], all: Row[]): Verdict[] {
  return entries.map((q) => {
    const mine = all.filter(
      (r) => r.suite === suiteOf(q) && r.file === q.file && r.title === q.title,
    );
    const results = mine.flatMap((r) => r.results);
    const runs = results.length;
    const passed = results.filter((x) => x.status === "passed").length;
    return {
      q,
      runs,
      passed,
      graduate: runs >= GRADUATE_RUNS && passed === runs,
    };
  });
}

/** The annotations (one line each) and the markdown summary. */
export function render(
  flakes: Row[],
  vs: Verdict[],
): { annotations: string[]; summary: string } {
  const annotations = flakes.map(
    (r) =>
      `::warning file=${prop(`apps/dashboard/e2e/${r.file}`)},line=${r.line},title=${prop("Flaky e2e test")}::${data(`${where(r)} failed, then passed on retry`)}`,
  );
  for (const v of vs.filter((v) => v.graduate))
    annotations.push(
      `::warning title=${prop("Quarantine: ready to come out")}::${data(`${v.q.file} › ${v.q.title} passed ${v.passed} of ${v.runs} runs; remove it from apps/dashboard/e2e/quarantine.json (owner: ${v.q.owner})`)}`,
    );
  const lines = ["## e2e: flaky and quarantined tests", ""];
  if (flakes.length === 0)
    lines.push("No flaky tests: nothing needed its retry.");
  else {
    lines.push(
      `**${flakes.length} flaky** (failed, then passed on retry):`,
      "",
      "| Suite | Test | File |",
      "|---|---|---|",
      ...flakes.map(
        (r) => `| ${r.suite} | ${cell(where(r))} | \`${r.file}:${r.line}\` |`,
      ),
    );
  }
  lines.push("");
  if (vs.length === 0) lines.push("Quarantine: empty.");
  else {
    lines.push(
      "| Quarantined test | Owner | Since | Passed | Verdict |",
      "|---|---|---|---|---|",
      ...vs.map(
        (v) =>
          `| ${cell(`${v.q.file} › ${v.q.title}`)} | ${cell(v.q.owner)} | ${v.q.since} | ${v.passed} of ${v.runs} | ${
            v.graduate
              ? "**ready to come out**"
              : v.runs === 0
                ? "did not run"
                : v.passed === v.runs
                  ? "passing"
                  : "still failing"
          } |`,
      ),
    );
  }
  return { annotations, summary: `${lines.join("\n")}\n` };
}

const readReport = (path: string) =>
  existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { suites?: PwSuite[] })
    : null;

function main(argv: string[]): number {
  const [cmd, a, b] = argv;
  if (cmd === "count" && (a === "mock" || a === "real")) {
    console.log(loadQuarantine().filter((q) => suiteOf(q) === a).length);
    return 0;
  }
  if (cmd === "summary" && a && b) {
    const merged = SUITES.flatMap((s) => {
      const r = readReport(join(a, `${s}.json`));
      return r ? rows(r, s) : [];
    });
    const quarantined = SUITES.flatMap((s) => {
      const r = readReport(join(b, `${s}.json`));
      return r ? rows(r, s) : [];
    });
    const { annotations, summary } = render(
      flaky(merged),
      verdicts(loadQuarantine(), quarantined),
    );
    for (const l of annotations) console.log(l);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    else process.stdout.write(summary);
    return 0;
  }
  console.error(
    "usage: e2e-report.ts count <mock|real> | summary <report dir> <quarantine dir>",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exit(main(process.argv.slice(2)));
