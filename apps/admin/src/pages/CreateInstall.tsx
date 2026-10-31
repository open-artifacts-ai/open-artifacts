import {
  AuthProviderSchema,
  AuthSchema,
  slugRule,
  type Tier,
  TierSchema,
} from "@oa/shared/provisioning";
import { Button, Input, Label } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { codeCopy } from "../api/errorCopy";
import { releasesQuery, slugQuery } from "../api/queries";
import { ErrorLine } from "../components/Bits";
import { useAction } from "../hooks/useAction";

const DEBOUNCE_MS = 300;

/** Slug rules on the client, then (after a pause) the live check. */
function useSlugStatus(slug: string) {
  const local = slug ? slugRule(slug) : null;
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSettled(slug), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [slug]);
  const remote = useQuery({
    ...slugQuery(settled),
    enabled: local === "ok" && settled === slug,
  });
  if (!slug) return { status: null, text: null };
  if (local !== "ok") return { status: local, text: codeCopy(`slug_${local}`) };
  if (settled !== slug || remote.isFetching)
    return { status: "checking", text: "Checking..." };
  if (remote.isError)
    return { status: "unknown", text: "Could not check the name." };
  const s = remote.data?.status;
  if (s === "ok") return { status: "ok", text: "Available." };
  return { status: s ?? "unknown", text: codeCopy(`slug_${s}`) };
}

export function CreateInstall() {
  const navigate = useNavigate();
  const releases = useQuery(releasesQuery());
  const installable = (releases.data?.items ?? []).filter((r) => r.installable);
  const latest = installable.find((r) => r.latest)?.version ?? "";
  const [slug, setSlug] = useState("");
  const [picked, setPicked] = useState("");
  const version = picked || latest;
  const check = useSlugStatus(slug);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [tier, setTier] = useState<Tier>("team");
  const [providers, setProviders] = useState<string[]>(["google"]);
  // Untouched, the sign-in domain is the owner's email domain.
  const [domainsText, setDomainsText] = useState<string | null>(null);
  const [sendWelcome, setSendWelcome] = useState(false);
  const domainsValue = domainsText ?? ownerEmail.split("@")[1] ?? "";
  const auth = AuthSchema.safeParse({
    providers: AuthProviderSchema.options.filter((p) => providers.includes(p)),
    domains: domainsValue
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  });
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail);
  const create = useAction(
    (_: void, requestId) =>
      api.call("R4", {
        body: {
          requestId,
          slug,
          ownerEmail,
          tier,
          auth: auth.data,
          ...(version ? { version } : {}),
          ...(sendWelcome ? { sendWelcome } : {}),
        },
      }),
    {
      invalidate: [["installs"], ["world"]],
      onSuccess: (r) =>
        void navigate({ to: "/jobs/$id", params: { id: r.job.id } }),
    },
  );
  return (
    <>
      <h1>Create install</h1>
      <form
        className="oa-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div>
          <Label htmlFor="slug">Name</Label>
          <Input
            id="slug"
            value={slug}
            autoComplete="off"
            aria-describedby="slug-status"
            onChange={(e) => setSlug(e.target.value)}
          />
          <small
            id="slug-status"
            data-testid="slug-status"
            data-status={check.status ?? ""}
            role="status"
          >
            {check.text}
          </small>
        </div>
        <div>
          <Label htmlFor="version">Version</Label>
          <select
            id="version"
            value={version}
            onChange={(e) => setPicked(e.target.value)}
          >
            {installable.map((r) => (
              <option key={r.version} value={r.version}>
                {r.version}
                {r.latest ? " (current)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="owner">Owner email</Label>
          <Input
            id="owner"
            type="email"
            value={ownerEmail}
            autoComplete="off"
            onChange={(e) => setOwnerEmail(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="tier">Plan</Label>
          <select
            id="tier"
            value={tier}
            onChange={(e) => setTier(e.target.value as Tier)}
          >
            {TierSchema.options.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend>Sign-in</legend>
          {AuthProviderSchema.options.map((p) => (
            <label key={p} className="oa-check">
              <input
                type="checkbox"
                checked={providers.includes(p)}
                onChange={(e) =>
                  setProviders((cur) =>
                    e.target.checked ? [...cur, p] : cur.filter((x) => x !== p),
                  )
                }
              />{" "}
              {p}
            </label>
          ))}
        </fieldset>
        <div>
          <Label htmlFor="domains">Allowed email domains</Label>
          <Input
            id="domains"
            value={domainsValue}
            placeholder="example.com"
            onChange={(e) => setDomainsText(e.target.value)}
          />
          {!auth.success && (
            <small>
              Pick a sign-in method; Google needs at least one valid domain.
            </small>
          )}
        </div>
        <label className="oa-check">
          <input
            type="checkbox"
            checked={sendWelcome}
            onChange={(e) => setSendWelcome(e.target.checked)}
          />{" "}
          Send the welcome email
        </label>
        <ErrorLine error={create.error} />
        <Button
          type="submit"
          disabled={
            check.status !== "ok" ||
            !version ||
            !emailOk ||
            !auth.success ||
            create.isPending
          }
        >
          Create install
        </Button>
      </form>
    </>
  );
}
