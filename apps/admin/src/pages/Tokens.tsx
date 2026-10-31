import { agentClients } from "@oa/shared";
import { type Token, TokenScopeSchema } from "@oa/shared/provisioning";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { tokensQuery } from "../api/queries";
import { ActionDialog } from "../components/ActionDialog";
import { ErrorLine } from "../components/Bits";
import { fmtAgo, fmtIn, fmtLeft } from "../components/labels";
import { useAction } from "../hooks/useAction";
import { LoadError } from "../layout/LoadError";

const LABEL_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
/** Live tokens and agents allowed at once, both kinds (the API answers token_limit past it; C1 does not export the number). */
export const TOKEN_LIVE_LIMIT = 5;
const MCP_URL = {
  prod: "https://api.open-artifacts.app/mcp",
  staging: "https://api.open-artifacts-staging.app/mcp",
} as const;
const REVOKE_ALL = "revoke all";
/** Design's consent labels for the scopes (the codes are C1's TokenScopeSchema). */
const SCOPE_LABEL = [
  ["installs:read", "Read installs"],
  ["audit:read", "Read the audit log"],
  ["installs:write", "Create and change installs"],
  ["installs:delete", "Delete and restore installs"],
  ["installs:pii", "See owner emails"],
] as const;
const LIFETIMES = [15, 30, 60] as const;

const isLive = (t: Token, now: number) => !t.revokedAt && t.expiresAt > now;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => setState((await copy(text)) ? "copied" : "failed")}
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : label}
    </Button>
  );
}

/** https://api.<app>/mcp: the admin host's sibling, else the per-environment default. */
export function mcpUrlFor(env: "prod" | "staging", host: string): string {
  if (host.startsWith("admin.") && host.includes(".", 6))
    return `https://api.${host.slice("admin.".length)}/mcp`;
  return MCP_URL[env];
}

function ConnectCard({ env }: { env: "prod" | "staging" }) {
  const url = mcpUrlFor(env, globalThis.location?.hostname ?? "");
  const snippets = agentClients(url, {
    name: "oa-admin",
    verifyTool: "get_world",
  });
  const agents = [...new Set(snippets.map((s) => s.agent))];
  const [agent, setAgent] = useState(agents[0]);
  const [variant, setVariant] = useState<"oauth" | "token">("oauth");
  const snip =
    snippets.find((s) => s.agent === agent && s.variant === variant) ??
    snippets.find((s) => s.agent === agent);
  return (
    <section className="oa-card" aria-label="Connect any AI agent">
      <h2>Connect any AI agent</h2>
      <p>
        It signs in through you and gets only the access you approve. Server{" "}
        <code>{url}</code>
      </p>
      <fieldset className="oa-seg">
        <legend className="sr-only">How it signs in</legend>
        {(
          [
            ["oauth", "Sign in with browser"],
            ["token", "Use a token"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={variant === v}
            onClick={() => setVariant(v)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <div className="oa-seg" role="tablist" aria-label="Agent">
        {agents.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={agent === a}
            onClick={() => setAgent(a)}
          >
            {a}
          </button>
        ))}
      </div>
      {snip && (
        <div data-testid="snippet">
          {snip.file && (
            <p>
              Put this in <code>{snip.file}</code>
            </p>
          )}
          <pre>
            <code>{snip.code}</code>
          </pre>
          {snip.language !== "text" && (
            <CopyButton text={snip.code} label="Copy" />
          )}
          {snip.hint && <p>{snip.hint}</p>}
          {snip.verify && <p>{snip.verify}</p>}
          {snip.reload && <p>{snip.reload}</p>}
        </div>
      )}
      <p className="oa-hint">
        Claude.ai: Settings, Connectors, Add custom connector, same server
        address.
      </p>
    </section>
  );
}

type Minted = {
  secret: string;
  label: string;
  scopes: string[];
  ttl: number;
};

function MintDialog({
  onClose,
  onMinted,
}: {
  onClose: () => void;
  onMinted: (m: Minted) => void;
}) {
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>([
    "installs:read",
    "audit:read",
  ]);
  const [ttl, setTtl] = useState<number>(15);
  const picked = TokenScopeSchema.options.filter((s) => scopes.includes(s));
  const mint = useAction(
    async (_: undefined, requestId) => {
      const r = await api.call("R19", {
        body: { requestId, label, scopes: picked, ttlMinutes: ttl },
      });
      // The secret goes to the page and never stays in the mutation result.
      onMinted({ secret: r.token, label, scopes: picked, ttl });
      return r.id;
    },
    { invalidate: [["tokens"]], key: [label, scopes, ttl] },
  );
  const ok =
    LABEL_RE.test(label) &&
    scopes.length > 0 &&
    LIFETIMES.some((m) => m === ttl);
  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Mint a token"
      submitLabel="Mint token"
      canSubmit={ok}
      pending={mint.isPending}
      error={mint.error}
      onSubmit={() => mint.mutate(undefined)}
    >
      <div>
        <Label htmlFor="tok-label">Label</Label>
        <Input
          id="tok-label"
          value={label}
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
        />
        <small className="oa-hint">Shown in the audit log.</small>
      </div>
      <fieldset>
        <legend>Scopes</legend>
        {SCOPE_LABEL.map(([s, name]) => (
          <label key={s} className="oa-check">
            <input
              type="checkbox"
              checked={scopes.includes(s)}
              onChange={(e) =>
                setScopes((cur) =>
                  e.target.checked ? [...cur, s] : cur.filter((x) => x !== s),
                )
              }
            />{" "}
            {name} <code>{s}</code>
          </label>
        ))}
      </fieldset>
      <fieldset className="oa-seg-field">
        <legend>Lifetime</legend>
        <div className="oa-seg">
          {LIFETIMES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={ttl === m}
              onClick={() => setTtl(m)}
            >
              {m} min
            </button>
          ))}
        </div>
        <small className="oa-hint">It also ends when you sign out.</small>
      </fieldset>
    </ActionDialog>
  );
}

function MintedDialog({ m, onDone }: { m: Minted; onDone: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent data-testid="secret">
        <DialogHeader>
          <DialogTitle>Token minted</DialogTitle>
          <DialogDescription>
            Copy it now. It won't be shown again.
          </DialogDescription>
        </DialogHeader>
        <code className="oa-secret-code">{m.secret}</code>
        <div>
          <CopyButton text={m.secret} label="Copy" />
        </div>
        <dl className="oa-fields">
          <dt>Label</dt>
          <dd>{m.label}</dd>
          <dt>Scopes</dt>
          <dd>{m.scopes.join(" ")}</dd>
          <dt>Ends</dt>
          <dd>in {m.ttl} min, or when you sign out</dd>
        </dl>
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Signed in (OAuth)" for a consent grant, "Token (oat_)" for a minted bearer. */
export const kindLabel = (t: Token) =>
  t.kind === "oauth" ? "Signed in (OAuth)" : "Token (oat_)";
/** "With your session · 6 h" for a grant, "in 38 min" for a bearer. */
export const endsLabel = (t: Token, now: number) =>
  t.kind === "oauth"
    ? `With your session · ${fmtLeft(t.expiresAt - now)}`
    : `in ${fmtIn(t.expiresAt - now)}`;

export function Tokens({ env }: { env: "prod" | "staging" }) {
  const q = useQuery(tokensQuery());
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const revoke = useAction(
    (id: string, _r) => api.call("R21", { params: { id } }),
    { invalidate: [["tokens"]] },
  );
  const revokeAll = useAction((_: undefined, _r) => api.call("R21"), {
    invalidate: [["tokens"]],
    onSuccess: () => setRevokingAll(false),
  });
  const now = Date.now();
  const live = (q.data?.items ?? []).filter((t) => isLive(t, now));
  const full = live.length >= TOKEN_LIVE_LIMIT;
  return (
    <>
      <div className="oa-head">
        <div style={{ flex: 1 }}>
          <h1>Agent tokens</h1>
          {q.data && (
            <p className="oa-sub">
              {live.length} of {TOKEN_LIVE_LIMIT} live. Every token ends with
              your admin session.
            </p>
          )}
        </div>
        <Button variant="destructive" onClick={() => setRevokingAll(true)}>
          Revoke all
        </Button>
        <Button onClick={() => setMinting(true)} disabled={full}>
          Mint token
        </Button>
      </div>
      {full && (
        <p className="oa-note" data-testid="token-limit">
          You have {TOKEN_LIVE_LIMIT} live tokens and agents. Revoke one to add
          another.
        </p>
      )}
      <ConnectCard env={env} />
      <ErrorLine error={revoke.error} />
      {q.isError ? (
        <LoadError
          title="Couldn't load tokens"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : q.data && live.length === 0 ? (
        <div className="oa-placeholder">
          <p>
            <strong>No agents yet</strong>
          </p>
          <p>Connect any AI agent above, or mint a token for a script.</p>
        </div>
      ) : q.data ? (
        <div className="oa-tablewrap">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>
                  <span className="sr-only">Revoke</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {live.map((t) => (
                <TableRow key={t.id} data-kind={t.kind}>
                  <TableCell>{t.clientName ?? t.label}</TableCell>
                  <TableCell>{kindLabel(t)}</TableCell>
                  <TableCell>{t.scopes.join(" ")}</TableCell>
                  <TableCell>{endsLabel(t, now)}</TableCell>
                  <TableCell>{fmtAgo(t.lastUsedAt, now)}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoke.isPending}
                      aria-label={`Revoke ${t.clientName ?? t.label}`}
                      onClick={() => revoke.mutate(t.id)}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {minting && (
        <MintDialog
          onClose={() => setMinting(false)}
          onMinted={(m) => {
            setMinting(false);
            setMinted(m);
          }}
        />
      )}
      {minted && <MintedDialog m={minted} onDone={() => setMinted(null)} />}
      {revokingAll && (
        <ActionDialog
          open
          onClose={() => {
            setRevokingAll(false);
            revokeAll.reset();
          }}
          title="Revoke all tokens"
          description="Every token and every connected AI agent stops working now."
          expected={REVOKE_ALL}
          submitLabel="Revoke all"
          destructive
          pending={revokeAll.isPending}
          error={revokeAll.error}
          onSubmit={() => revokeAll.mutate(undefined)}
        />
      )}
    </>
  );
}
