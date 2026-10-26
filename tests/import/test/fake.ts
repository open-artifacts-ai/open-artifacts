// An in-process fake of the install's REST API (no sockets): the endpoints
// snapshot and checkImport read, in the shapes apps/server returns, plus an
// `importKey` on each artifact summary (the assumed field, see src/check.ts).

export interface FakeUser {
  id: string;
  email: string;
  token: string;
}

interface FakeVersion {
  version: number;
  files: Record<string, string>;
}

interface FakeArtifact {
  id: string;
  ownerId: string;
  spaceId: string;
  importKey: string | null;
  versions: FakeVersion[];
}

interface FakeSpace {
  id: string;
  name: string;
  kind: "personal" | "shared";
}

export class FakeInstall {
  users: FakeUser[] = [];
  spaces: FakeSpace[] = [];
  artifacts: FakeArtifact[] = [];
  /** Page sizes, small so the checker has to page. */
  listPage = 3;
  versionsPage = 2;
  /** When set, every request answers this status and body. */
  failWith: { status: number; body: string } | null = null;
  requests: string[] = [];
  private seq = 0;

  addUser(email: string): FakeUser {
    const id = `u${this.users.length + 1}`.padEnd(8, "0");
    const u = { id, email, token: `tok-${id}-${"x".repeat(24)}` };
    this.users.push(u);
    this.spaces.push({ id, name: email, kind: "personal" });
    return u;
  }

  addSpace(name: string): string {
    const id = `s${this.spaces.length + 1}`.padEnd(8, "0");
    this.spaces.push({ id, name, kind: "shared" });
    return id;
  }

  /** Creates an artifact; returns its id. */
  create(o: {
    ownerId: string;
    spaceId: string;
    importKey: string | null;
    files: Record<string, string>;
  }): string {
    const id = `a${String(++this.seq).padStart(7, "0")}`;
    this.artifacts.push({
      id,
      ownerId: o.ownerId,
      spaceId: o.spaceId,
      importKey: o.importKey,
      versions: [{ version: 1, files: o.files }],
    });
    return id;
  }

  /** Adds a version whatever its content. */
  addVersion(id: string, files: Record<string, string>): void {
    const a = this.mustGet(id);
    a.versions.push({ version: a.versions.length + 1, files });
  }

  /** Deletes an artifact (the list omits deleted ones). */
  remove(id: string): void {
    this.artifacts = this.artifacts.filter((a) => a.id !== id);
  }

  /**
   * The real list's rule as far as this fake models it (private artifacts, no
   * shares): the caller's own artifacts, anything in the caller's personal
   * space, and anything in a shared space (every user here has a role in
   * every shared space). Another user's personal space is invisible.
   */
  private visible(a: FakeArtifact, userId: string): boolean {
    if (a.ownerId === userId || a.spaceId === userId) return true;
    return this.spaces.some((s) => s.id === a.spaceId && s.kind === "shared");
  }

  mustGet(id: string): FakeArtifact {
    const a = this.artifacts.find((x) => x.id === id);
    if (!a) throw new Error(`no artifact ${id}`);
    return a;
  }

  private user(id: string) {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new Error(`no user ${id}`);
    return { id: u.id, email: u.email, name: null };
  }

  private spaceRef(id: string) {
    const s = this.spaces.find((x) => x.id === id);
    if (!s) throw new Error(`no space ${id}`);
    return { id: s.id, kind: s.kind, name: s.name, publicLinks: true };
  }

  private summary(a: FakeArtifact) {
    const now = "2026-10-26T00:00:00.000Z";
    return {
      id: a.id,
      title: "Imported",
      description: null,
      format: "html",
      visibility: "private",
      owner: this.user(a.ownerId),
      currentVersion: a.versions.length,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      lastAgent: null,
      thumbnailUrl: null,
      thumbnailVersion: null,
      access: "owner",
      capabilities: {},
      allowAnonymousWrites: false,
      space: this.spaceRef(a.spaceId),
      importKey: a.importKey,
    };
  }

  /** A fetch that answers from this fake. */
  fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (this.failWith)
      return new Response(this.failWith.body, { status: this.failWith.status });
    const auth = req.headers.get("authorization") ?? "";
    const me = this.users.find((u) => auth === `Bearer ${u.token}`);
    if (!me) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (req.method !== "GET") return new Response(null, { status: 405 });
    const p = url.pathname;
    const page = <T>(items: T[], size: number) => {
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Math.min(
        Number(url.searchParams.get("limit") ?? size),
        size,
      );
      const slice = items.slice(start, start + limit);
      const next = start + limit < items.length ? String(start + limit) : null;
      return Response.json({ items: slice, nextCursor: next });
    };

    if (p === "/api/v1/me")
      // MeSchema as apps/server returns it: no personalSpaceId.
      return Response.json({
        user: { ...this.user(me.id), role: "member" },
      });
    if (p === "/api/v1/spaces")
      // listSpaces: the caller's personal space (kind "personal", id = user
      // id) first, then shared spaces.
      return page(
        [
          ...this.spaces.filter((s) => s.kind === "personal" && s.id === me.id),
          ...this.spaces.filter((s) => s.kind === "shared"),
        ].map((s) => this.spaceRef(s.id)),
        this.listPage,
      );
    if (p === "/api/v1/artifacts") {
      if (url.searchParams.get("scope") !== "all")
        return Response.json(
          { error: "test expects scope=all" },
          { status: 400 },
        );
      return page(
        this.artifacts
          .filter((a) => this.visible(a, me.id))
          .map((a) => this.summary(a)),
        this.listPage,
      );
    }
    const m = p.match(
      /^\/api\/v1\/artifacts\/([^/]+)\/versions(?:\/(\d+)\/files\/(.+))?$/,
    );
    if (m) {
      const a = this.artifacts.find((x) => x.id === decodeURIComponent(m[1]));
      if (!a || !this.visible(a, me.id))
        return Response.json({ error: "not_found" }, { status: 404 });
      if (m[2]) {
        const v = a.versions.find((x) => x.version === Number(m[2]));
        const path = m[3].split("/").map(decodeURIComponent).join("/");
        const body = v?.files[path];
        if (body === undefined)
          return Response.json({ error: "not_found" }, { status: 404 });
        return new Response(body);
      }
      const before = Number(
        url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
      );
      const vs = a.versions
        .filter((v) => v.version < before)
        .sort((x, y) => y.version - x.version)
        .slice(0, this.versionsPage)
        .map((v) => ({
          version: v.version,
          message: null,
          agent: null,
          createdBy: this.user(a.ownerId),
          createdAt: "2026-10-26T00:00:00.000Z",
          entry: Object.keys(v.files)[0],
          files: Object.entries(v.files).map(([path, body]) => ({
            path,
            size: Buffer.byteLength(body),
            contentType: "text/plain",
          })),
          language: null,
          textIndexed: false,
          format: "html",
        }));
      return Response.json(vs);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}
