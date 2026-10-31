import { agentClients } from "@oa/shared";
import { type Token, TokenScopeSchema } from "@oa/shared/provisioning";
import { Button, Input, Label } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { tokensQuery } from "../api/queries";
import { ActionDialog } from "../components/ActionDialog";
import { ErrorLine } from "../components/Bits";
import { fmtTime } from "../components/format";
import { useAction } from "../hooks/useAction";
import { LoadError } from "../layout/LoadError";

const LABEL_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
const MCP_URL = {
  prod: "https://api.open-artifacts.app/mcp",
  staging: "https://api.open-artifacts-staging.app/mcp",
} as const;
const REVOKE_ALL = "revoke all";

const status = (t: Token, now: number) =>
  t.revokedAt ? "revoked" : t.expiresAt <= now ? "expired" : "active";

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
        Any AI agent that speaks MCP can sign in with your admin account and
        manage installs.
      </p>
      <p>
        Server address: <code>{url}</code>{" "}
        <CopyButton text={url} label="Copy address" />
      </p>
      <div className="oa-filter">
        <label>
          Agent{" "}
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>{" "}
        <label>
          Sign in with{" "}
          <select
            value={variant}
            onChange={(e) => setVariant(e.target.value as "oauth" | "token")}
          >
            <option value="oauth">Browser (OAuth)</option>
            <option value="token">Token</option>
          </select>
        </label>
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
            <CopyButton text={snip.code} label="Copy snippet" />
          )}
          {snip.hint && <p>{snip.hint}</p>}
          {snip.verify && <p>Check: {snip.verify}</p>}
          {snip.reload && <p>{snip.reload}</p>}
        </div>
      )}
    </section>
  );
}

function Mint({ onMinted }: { onMinted: (secret: string) => void }) {
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["installs:read"]);
  const [ttl, setTtl] = useState(15);
  const mint = useAction(
    async (_: void, requestId) => {
      const r = await api.call("R19", {
        body: {
          requestId,
          label,
          scopes: TokenScopeSchema.options.filter((s) => scopes.includes(s)),
          ttlMinutes: ttl,
        },
      });
      // The secret goes to the page and never stays in the mutation result.
      onMinted(r.token);
      return r.id;
    },
    {
      invalidate: [["tokens"]],
      onSuccess: () => setLabel(""),
      key: [label, scopes, ttl],
    },
  );
  const ok =
    LABEL_RE.test(label) &&
    scopes.length > 0 &&
    Number.isInteger(ttl) &&
    ttl >= 5 &&
    ttl <= 60;
  return (
    <form
      className="oa-form"
      aria-label="Mint a token"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) mint.mutate();
      }}
    >
      <h2>Mint a token</h2>
      <div>
        <Label htmlFor="tok-label">Label</Label>
        <Input
          id="tok-label"
          value={label}
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <fieldset>
        <legend>Scopes</legend>
        {TokenScopeSchema.options.map((s) => (
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
            {s}
          </label>
        ))}
      </fieldset>
      <div>
        <Label htmlFor="tok-ttl">Lasts (5 to 60 minutes)</Label>
        <Input
          id="tok-ttl"
          type="number"
          min={5}
          max={60}
          value={ttl}
          onChange={(e) => setTtl(Number(e.target.value))}
        />
      </div>
      <ErrorLine error={mint.error} />
      <Button type="submit" disabled={!ok || mint.isPending}>
        Mint token
      </Button>
    </form>
  );
}

export function Tokens({ env }: { env: "prod" | "staging" }) {
  const q = useQuery(tokensQuery());
  const [secret, setSecret] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const revoke = useAction(
    (id: string, _r) => api.call("R21", { params: { id } }),
    { invalidate: [["tokens"]] },
  );
  const revokeAll = useAction((_: void, _r) => api.call("R21"), {
    invalidate: [["tokens"]],
    onSuccess: () => setRevokingAll(false),
  });
  const now = Date.now();
  return (
    <>
      <h1>Tokens</h1>
      <ConnectCard env={env} />
      {secret !== null && (
        <div className="oa-secret" role="alert" data-testid="secret">
          <strong>Copy this token now. It is shown only once.</strong>
          <code>{secret}</code>
          <CopyButton text={secret} label="Copy token" />{" "}
          <Button variant="outline" size="sm" onClick={() => setSecret(null)}>
            I have copied it
          </Button>
        </div>
      )}
      <Mint onMinted={setSecret} />
      <div className="oa-head">
        <h2>Tokens</h2>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setRevokingAll(true)}
        >
          Revoke all
        </Button>
      </div>
      <ErrorLine error={revoke.error} />
      {q.isError ? (
        <LoadError
          title="Couldn't load tokens"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : q.data && q.data.items.length === 0 ? (
        <p className="oa-placeholder">No tokens.</p>
      ) : q.data ? (
        <ul className="oa-tokens">
          {q.data.items.map((t) => {
            const st = status(t, now);
            return (
              <li key={t.id} data-status={st}>
                <strong>{t.clientName ?? t.label}</strong> ({t.kind}, {st}){" "}
                {t.scopes.join(", ")}. Created {fmtTime(t.createdAt)}, ends{" "}
                {fmtTime(t.expiresAt)}, last used {fmtTime(t.lastUsedAt)}.{" "}
                {st === "active" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending}
                    aria-label={`Revoke ${t.clientName ?? t.label}`}
                    onClick={() => revoke.mutate(t.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
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
          onSubmit={() => revokeAll.mutate()}
        />
      )}
    </>
  );
}
