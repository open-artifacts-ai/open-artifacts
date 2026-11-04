import { describe, expect, it } from "vitest";
import {
  NamespaceSchema,
  namespaceFrom,
  normalizeRemote,
  WireNamespaceSchema,
} from "../src/namespace.js";

describe("normalizeRemote", () => {
  it("makes the same repo equal across machines", () => {
    const forms = [
      "git@github.com:Acme/Widgets.git",
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
      "https://user:tok@GitHub.com/acme/widgets/",
    ];
    const out = forms.map(normalizeRemote);
    expect(new Set(out)).toEqual(new Set(["github.com/acme/widgets"]));
  });
  it("returns null for local paths and junk", () => {
    for (const u of [
      "/Users/me/repo",
      "../x",
      "file:///tmp/x",
      "",
      "not a url",
    ]) {
      expect(normalizeRemote(u)).toBeNull();
    }
  });
});

describe("namespaceFrom", () => {
  it("prefers the remote", () => {
    expect(
      namespaceFrom({
        remoteUrl: "git@github.com:A/B.git",
        gitRootName: "b",
        cwd: "/x/b",
      }),
    ).toBe("github.com/a/b");
  });
  it("falls back to the git root name, then the cwd basename", () => {
    expect(
      namespaceFrom({ remoteUrl: null, gitRootName: "Widgets", cwd: "/x/y" }),
    ).toBe("widgets");
    expect(
      namespaceFrom({ remoteUrl: null, gitRootName: null, cwd: "/x/My Repo" }),
    ).toBe("my-repo");
  });
  it("never returns an empty namespace", () => {
    expect(
      namespaceFrom({ remoteUrl: null, gitRootName: null, cwd: "/" }),
    ).toBe("default");
  });
});

describe("normalizeRemote hardening", () => {
  it("A: `.git/` equals the plain form", () => {
    expect(normalizeRemote("git@github.com:acme/widgets.git/")).toBe(
      "github.com/acme/widgets",
    );
    expect(normalizeRemote("https://github.com/acme/widgets.git/")).toBe(
      "github.com/acme/widgets",
    );
  });
  it("B: scp and https agree on dot segments", () => {
    expect(normalizeRemote("git@github.com:acme/./widgets")).toBe(
      "github.com/acme/widgets",
    );
    expect(normalizeRemote("git@github.com:acme/./widgets")).toBe(
      normalizeRemote("https://github.com/acme/./widgets"),
    );
  });
  it("C: single-label, IP, localhost, git+ssh and ~user remotes normalize", () => {
    const want: Record<string, string> = {
      "git@gitserver:team/widgets.git": "gitserver/team/widgets",
      "ssh://git@10.0.0.5/team/widgets.git": "10.0.0.5/team/widgets",
      "https://localhost:3000/team/widgets": "localhost/team/widgets",
      "git+ssh://git@github.com/acme/widgets.git": "github.com/acme/widgets",
      "ssh://git@github.com/~alice/widgets.git": "github.com/~alice/widgets",
    };
    for (const [r, w] of Object.entries(want))
      expect(normalizeRemote(r), r).toBe(w);
  });
  it("C: a bare `word:path` or a Windows path is not a remote", () => {
    for (const r of ["foo:bar", "C:\\Users\\x", "C:/x/y"]) {
      expect(normalizeRemote(r), r).toBeNull();
    }
  });
  it("C2: same-named repos on one internal host do not collide", () => {
    const a = namespaceFrom({
      remoteUrl: "git@gitserver:team-a/widgets.git",
      gitRootName: "widgets",
      cwd: "/w",
    });
    const b = namespaceFrom({
      remoteUrl: "git@gitserver:team-b/widgets.git",
      gitRootName: "widgets",
      cwd: "/w",
    });
    expect(a).not.toBe(b);
  });
  it("D: long paths are hashed, not truncated into collisions", () => {
    const stem = `gitlab.com/${"group/".repeat(20)}`;
    const a = normalizeRemote(`https://${stem}service-alpha`);
    const b = normalizeRemote(`https://${stem}service-beta`);
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a?.length).toBe(128);
    expect(a).toBe(
      normalizeRemote(
        `git@gitlab.com:${stem.slice("gitlab.com/".length)}service-alpha.git`,
      ),
    );
    expect(a).toMatch(/-[0-9a-f]{8}$/);
  });
  it("E/F: port is dropped and the path is lowercased, on purpose", () => {
    // Intentional (spec: same repo on two machines is one namespace): ports and
    // case differ across clones of one repo, so they are not part of identity.
    expect(normalizeRemote("https://git.example.com:8443/team/app")).toBe(
      normalizeRemote("https://git.example.com/team/app"),
    );
    expect(normalizeRemote("git@git.example.com:team/App.git")).toBe(
      normalizeRemote("git@git.example.com:team/app.git"),
    );
  });
});

describe("namespaceFrom fallback hardening", () => {
  it("G: Windows cwd uses its basename", () => {
    expect(
      namespaceFrom({
        remoteUrl: null,
        gitRootName: null,
        cwd: "C:\\Users\\alice\\widgets",
      }),
    ).toBe("widgets");
  });
  it("H: diacritics fold; other non-ASCII names get a stable distinct hash", () => {
    expect(
      namespaceFrom({ remoteUrl: null, gitRootName: "Café Projet", cwd: "/x" }),
    ).toBe("cafe-projet");
    const a = namespaceFrom({
      remoteUrl: null,
      gitRootName: "проект",
      cwd: "/home/u/проект",
    });
    const b = namespaceFrom({
      remoteUrl: null,
      gitRootName: "프로젝트",
      cwd: "/home/u/프로젝트",
    });
    expect(a).toMatch(/^dir-[0-9a-f]{8}$/);
    expect(b).toMatch(/^dir-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(a).toBe(
      namespaceFrom({
        remoteUrl: null,
        gitRootName: null,
        cwd: "/elsewhere/проект",
      }),
    );
  });
});

describe("namespace slug stability", () => {
  const ns = (name: string) =>
    namespaceFrom({ remoteUrl: null, gitRootName: name, cwd: "/x" });
  it("NFC and NFD forms of one name give the same namespace", () => {
    const nfc = "프로젝트".normalize("NFC");
    const nfd = "프로젝트".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(ns(nfc)).toBe(ns(nfd));
  });
  it("partly non-ASCII names do not collide on their ASCII remainder", () => {
    const a = ns("проект-v2");
    const b = ns("задача-v2");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v2-[0-9a-f]{8}$/);
  });
  it("pure ASCII and diacritic-only names are unchanged", () => {
    expect(ns("café")).toBe("cafe");
    expect(ns("Widgets")).toBe("widgets");
    expect(ns("my-repo")).toBe("my-repo");
  });
});

describe("NamespaceSchema hardening", () => {
  it("I: rejects C1, bidi, zero-width, BOM and line separators", () => {
    for (const s of [
      "a\u200b",
      "a\u200d",
      "a\u200e",
      "a\u202a",
      "a\u202e",
      "a\u2066",
      "a\u2069",
      "a\u2060",
      "a\u061c",
      "a\u0085",
      "a\u009f",
      "a\u2028",
      "a\u2029",
      "a\ufeff",
      "a\u0000",
      "a\u007f",
    ]) {
      expect(NamespaceSchema.safeParse(s).success, JSON.stringify(s)).toBe(
        false,
      );
    }
  });
  it("J: a remote-shaped namespace is normalized; anything else is slugged", () => {
    expect(NamespaceSchema.parse("https://github.com/Acme/Widgets.git")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("git@github.com:Acme/Widgets")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("github.com/acme/widgets")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("My Team")).toBe("my-team");
  });
  it("J: a scheme-less host.tld/owner/repo is normalized like its https form", () => {
    expect(NamespaceSchema.parse("GitHub.com/Acme/Widgets")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("GitHub.com/Acme/Widgets.git/")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("My/Team")).toBe("my/team");
    expect(NamespaceSchema.parse("Acme Widgets.com/x")).toBe(
      "acme-widgets.com/x",
    );
  });
});

describe("config namespaces are always wire-canonical", () => {
  const inputs = [
    "https://github.com/Acme/Widgets.git",
    "git@github.com:Acme/Widgets",
    "ssh://git@host:2222/Org/Repo.git",
    "github.com/acme/widgets",
    "GitHub.com/Acme/Widgets.git/",
    `https://github.com/${"a".repeat(200)}/${"b".repeat(50)}`,
    `git@github.com:${"x".repeat(300)}/y.git`,
    "~user",
    "~user/proj",
    "My Team",
    "My/Team",
    "Acme Widgets.com/x",
    "Café Ünï",
    "日本語プロジェクト",
    "naïve résumé",
    "ÀÉÎÕÜ",
    "MiXeD CaSe",
    "C:\\Users\\Me\\Proj",
    "\\\\server\\share\\dir",
    "foo:bar",
    "a_b.c-d",
    "   ",
    "-",
    "...",
    "x".repeat(128),
    "é".repeat(100),
    "UPPER".repeat(25),
    "emoji 🚀 team",
  ];
  it("every successful NamespaceSchema parse passes the wire schema", () => {
    for (const s of inputs) {
      const r = NamespaceSchema.safeParse(s);
      if (r.success) {
        expect(WireNamespaceSchema.safeParse(r.data).success, s).toBe(true);
        expect(NamespaceSchema.parse(r.data), s).toBe(r.data); // idempotent
      }
    }
    expect(NamespaceSchema.safeParse("My Team").success).toBe(true);
  });
  it("every namespaceFrom result passes the wire schema", () => {
    for (const s of inputs) {
      for (const input of [
        { remoteUrl: s, gitRootName: null, cwd: "/x" },
        { remoteUrl: null, gitRootName: s, cwd: "/x" },
        { remoteUrl: null, gitRootName: null, cwd: s },
        { remoteUrl: null, gitRootName: null, cwd: `/home/${s}` },
      ]) {
        const ns = namespaceFrom(input);
        expect(WireNamespaceSchema.safeParse(ns).success, `${s} -> ${ns}`).toBe(
          true,
        );
      }
    }
  });
});

describe("NamespaceSchema is idempotent", () => {
  const fixed = (x: string) => {
    const r = NamespaceSchema.safeParse(x);
    if (!r.success) return;
    expect(NamespaceSchema.parse(r.data), JSON.stringify(x)).toBe(r.data);
    expect(WireNamespaceSchema.safeParse(r.data).success, r.data).toBe(true);
  };
  it("dot segments, `~` and `--` survive a second parse", () => {
    expect(NamespaceSchema.parse("Acme.io/x/../y z")).toBe("acme.io/y-z");
    expect(NamespaceSchema.parse("acme.io/y-z")).toBe("acme.io/y-z");
    expect(NamespaceSchema.parse("host/~user/r")).toBe("host/~user/r");
    expect(NamespaceSchema.parse("xn--e1aybc/o/r")).toBe("xn--e1aybc/o/r");
    expect(NamespaceSchema.parse("../a//b/./c/..")).toBe("a/b");
    for (const x of [
      "Acme.io/x/../y z",
      "host/~user/r",
      "xn--e1aybc/o/r",
      "git@host:~user/r",
    ])
      fixed(x);
  });
  it("namespaceFrom results are fixed points and wire-valid", () => {
    const r = namespaceFrom({
      remoteUrl: "git@host:~user/r",
      gitRootName: null,
      cwd: "/x",
    });
    expect(NamespaceSchema.parse(r)).toBe(r);
    expect(WireNamespaceSchema.safeParse(r).success).toBe(true);
  });
  it("fuzz: 20k seeded inputs are fixed points and wire-valid", () => {
    let seed = 0x2f6e2b1;
    const rnd = () => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const atoms = [
      "/",
      "/",
      ".",
      "..",
      "~",
      "-",
      "--",
      "_",
      ":",
      "@",
      "\\",
      " ",
      "a",
      "b",
      "x",
      "Z",
      "Q",
      "0",
      "7",
      "xn--",
      ".git",
      "www.",
      "host",
      "acme.io",
      "https://",
      "git@",
      "ssh://",
      "é",
      "ü",
      "日",
      "🚀",
      "ß",
    ];
    let ok = 0;
    for (let i = 0; i < 20000; i++) {
      const n = 1 + Math.floor(rnd() * 14);
      let x = "";
      for (let j = 0; j < n; j++) x += atoms[Math.floor(rnd() * atoms.length)];
      if (rnd() < 0.01) x = x.repeat(1 + Math.floor(rnd() * 40));
      if (NamespaceSchema.safeParse(x).success) ok++;
      fixed(x);
      const f = namespaceFrom({ remoteUrl: x, gitRootName: x, cwd: x });
      expect(NamespaceSchema.parse(f), JSON.stringify(x)).toBe(f);
      expect(WireNamespaceSchema.safeParse(f).success, f).toBe(true);
    }
    expect(ok).toBeGreaterThan(5000);
    // 20k parses take ~1-2 s locally but brushed vitest's 5 s default on a
    // loaded CI runner (#76); the bound is generous, not a timing assertion.
  }, 30_000);
  it("stacked .git suffixes strip in one pass", () => {
    for (const n of [10, 50]) {
      for (const x of [
        `git@acme.io:o/r${"/.git".repeat(n)}`,
        `https://acme.io/o/r${".git".repeat(n)}`,
      ]) {
        const r = NamespaceSchema.parse(x);
        expect(r, `${n}`).toBe("acme.io/o/r");
        expect(NamespaceSchema.parse(r)).toBe(r);
      }
    }
  });
});

describe("degenerate config namespaces", () => {
  it("empty and whitespace-only are rejected", () => {
    for (const x of ["", " ", "  \t"])
      expect(NamespaceSchema.safeParse(x).success, JSON.stringify(x)).toBe(
        false,
      );
  });
  it("dot/slash/dash inputs are never empty, wire-valid and not `default`", () => {
    const inputs = [".", "..", "//", "./", "/.", "../..", "-", "~"];
    const out = new Map<string, string>();
    for (const x of inputs) {
      const r = NamespaceSchema.safeParse(x);
      if (!r.success) continue;
      expect(r.data, x).not.toBe("");
      expect(r.data, x).not.toBe("default");
      expect(WireNamespaceSchema.safeParse(r.data).success, x).toBe(true);
      expect(NamespaceSchema.parse(r.data), x).toBe(r.data);
      out.set(x, r.data);
    }
    // inputs that differ in raw text must not all collapse together
    expect(new Set([out.get("."), out.get(".."), out.get("//")]).size).toBe(3);
  });
});
