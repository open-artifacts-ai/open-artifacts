// P3 T16: the authorization probe for a live instance (P4 go-live, P5).
//
//   pnpm -F @oa/server test:authz-probe --base https://app.example --creds creds.json
//
// Read-only: it runs every SURFACES, ORG_SURFACES and SPACE_SURFACES probe
// that writes nothing (the `mutates` ones are skipped) for each caller in
// the file, and compares the answers with test/authz/expect.ts. Exit 0: all
// match; 1: a mismatch or an unclassifiable answer; 2: bad usage.
//
// Exit 1 is expected while the matrix pins a known bug (KNOWN in
// test/authz.surface-matrix.test.ts): the probe reports the truth, the
// matrix pins it. Anonymous probes (sockets, data writes) count against
// RL_ANON per IP: past 30 a minute they answer 429, which shows as an
// "error:" mismatch. Rerun after a minute, or probe from more than one IP.
//
// Credentials come only from the --creds file. Any other flag, a
// credential-looking argument, or a credential in the environment is
// refused (exit 2), so nothing lands in shell history or CI logs.
//
// The file (JSON):
//   {
//     "callers":   { "<caller>": { "cookie"?, "token"?, "email"? }, ... },
//     "artifacts": { "<artifact>": "<id>", ... },
//     "org"?:      { "spaceId", "memberId", "departedId" },
//     "space"?:    { "spaceId", "personalSpaceId", "memberId", "editorId",
//                    "managerId", "groups": { "viewer", "manager", "free" } },
//     "contentBase"?: "https://content.example"
//   }
// Callers and artifacts are the names in expect.ts, built as its WORLD
// describes (artifact titles carry their id; doc "d" in collection "c";
// db, storage and viewer declared; a thumbnail stored). Missing callers or
// artifacts are skipped; /p/ needs contentBase.
import {
  ARTIFACTS,
  type ArtifactName,
  CALLERS,
  type CallerName,
  expected,
  orgExpected,
  spaceExpected,
} from "../test/authz/expect.ts";
import {
  type Cred,
  ORG_SURFACES,
  type OrgTarget,
  type ProbeIO,
  SPACE_SURFACES,
  type SpaceTarget,
  SURFACES,
} from "../test/authz/surfaces.ts";

export { ORG_SURFACES, SPACE_SURFACES, SURFACES };

type CredsFile = {
  callers: Partial<Record<CallerName, Cred>>;
  artifacts: Partial<Record<ArtifactName, string>>;
  org?: OrgTarget;
  space?: SpaceTarget;
  contentBase?: string;
};

export type Deps = {
  readFile?: (path: string) => Promise<string>;
  fetch?: ProbeIO["fetch"];
  log?: (line: string) => void;
  /** Runs only the surfaces (or routes) this accepts (the matrix splits the run). */
  only?: (name: string) => boolean;
};

const USAGE = "usage: authz-probe --base <url> --creds <file>";
/** Values that look like a credential (a PAT, a grant, a session cookie). */
const SECRET =
  /oa_pat_|oa_session=|bearer\s|(^|[\s"'=])[1-9A-HJ-NP-Za-km-z]{16}:[\w-]+:[\w-]{8,}/i;
/** Environment names that would carry a credential. */
const SECRET_ENV =
  /^(OA|AUTHZ_PROBE)_(PAT|TOKEN|COOKIE|SESSION|BEARER|CREDS?|GRANT)(_|$)/i;

/** Parses argv strictly; a string is the refusal reason. */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { base: string; creds: string } | string {
  const leaked = Object.entries(env).find(
    ([k, v]) => SECRET_ENV.test(k) || (v !== undefined && SECRET.test(v)),
  );
  if (leaked)
    return `refusing: credentials in the environment (${leaked[0]}); put them in the --creds file`;
  const out: Record<string, string> = {};
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] as string;
    const value = args[i + 1];
    if (flag !== "--base" && flag !== "--creds")
      return `refusing: unknown argument ${flag.slice(0, 20)} (credentials go in the --creds file)\n${USAGE}`;
    if (value === undefined || value.startsWith("--") || flag in out)
      return USAGE;
    if (SECRET.test(value))
      return "refusing: a credential in the arguments; put it in the --creds file";
    out[flag] = value;
  }
  const base = out["--base"];
  const creds = out["--creds"];
  if (!base || !creds) return USAGE;
  if (!/^https?:\/\/[^/]+$/.test(base.replace(/\/$/, "")))
    return `refusing: --base must be an origin (${USAGE})`;
  return { base: base.replace(/\/$/, ""), creds };
}

/** Runs the probe; resolves to the exit code. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: Deps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const args = parseArgs(argv, env);
  if (typeof args === "string") {
    log(args);
    return 2;
  }
  const read =
    deps.readFile ??
    (async (p: string) =>
      (await import("node:fs/promises")).readFile(p, "utf8"));
  let file: CredsFile;
  try {
    file = JSON.parse(await read(args.creds)) as CredsFile;
  } catch (e) {
    log(`refusing: can't read --creds (${(e as Error).message})`);
    return 2;
  }
  const unknown = [
    ...Object.keys(file.callers ?? {}).filter(
      (c) => !(CALLERS as readonly string[]).includes(c),
    ),
    ...Object.keys(file.artifacts ?? {}).filter(
      (a) => !(ARTIFACTS as readonly string[]).includes(a),
    ),
  ];
  if (unknown.length) {
    log(`refusing: unknown names in --creds: ${unknown.join(", ")}`);
    return 2;
  }
  const io: ProbeIO = {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(file.contentBase ? { contentBase: file.contentBase } : {}),
  };
  const callers = CALLERS.filter((c) => file.callers?.[c] !== undefined);
  const arts = ARTIFACTS.filter((a) => file.artifacts?.[a] !== undefined);
  let cells = 0;
  const bad: string[] = [];
  const check = async (
    label: string,
    want: string,
    run: () => Promise<string>,
  ) => {
    cells++;
    const got = await run().catch((e: Error) => `error: ${e.message}`);
    if (got !== want) bad.push(`${label}: got ${got}, want ${want}`);
  };
  const only = deps.only ?? (() => true);
  for (const s of SURFACES) {
    if (s.mutates || !only(s.name)) continue;
    if (s.action === "public.link" && !io.contentBase) continue;
    await Promise.all(
      callers.flatMap((who) =>
        arts.map((art) =>
          check(
            `${s.name} ${who} ${art}`,
            expected(who, art, s.action, s.via),
            () =>
              s.probe(
                args.base,
                file.callers[who] as Cred,
                file.artifacts[art] as string,
                io,
              ),
          ),
        ),
      ),
    );
  }
  if (file.org)
    for (const s of ORG_SURFACES) {
      // realOnly: no refusal mode that holds here (only the matrix shows it).
      if (s.mutates || s.realOnly || !only(s.route)) continue;
      await Promise.all(
        callers.map((who) =>
          check(`${s.route} ${who}`, orgExpected(who, s.rule, s.route), () =>
            s.probe(
              args.base,
              file.callers[who] as Cred,
              file.org as OrgTarget,
              io,
            ),
          ),
        ),
      );
    }
  if (file.space)
    for (const s of SPACE_SURFACES) {
      if (s.mutates || !only(s.name)) continue;
      await Promise.all(
        callers.map((who) =>
          check(`space ${s.name} ${who}`, spaceExpected(who, s.rule), () =>
            s.probe(
              args.base,
              file.callers[who] as Cred,
              file.space as SpaceTarget,
              io,
            ),
          ),
        ),
      );
    }
  for (const b of bad) log(`MISMATCH ${b}`);
  log(`${cells} cells, ${bad.length} mismatches`);
  return bad.length ? 1 : 0;
}

const direct = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      process.argv[1] !== undefined &&
      import.meta.url === new URL(`file://${process.argv[1]}`).href
    );
  } catch {
    return false;
  }
})();
if (direct)
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
