import {
  AuthProviderSchema,
  AuthSchema,
  JOB_STEPS,
  slugRule,
  type Tier,
  TierSchema,
} from "@oa/shared/provisioning";
import { Button, Input, Label } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { releasesQuery, slugQuery } from "../api/queries";
import { ErrorLine } from "../components/Bits";
import { visibleSteps } from "../components/labels";
import { useAction } from "../hooks/useAction";

const DEBOUNCE_MS = 300;
/** Design's slug-check copy (W11). */
const SLUG_COPY = {
  invalid: "Use lowercase letters, numbers and hyphens.",
  reserved: "That name is reserved.",
  taken: "That name is taken.",
} as const;
/** Slug answers shown as an error (red help, red border). */
const BAD_SLUG = new Set(["invalid", "reserved", "taken"]);
const APP_DOMAIN = {
  prod: "open-artifacts.app",
  staging: "open-artifacts-staging.app",
} as const;
/** The app domain: the admin host minus "admin.", else the per-environment default. */
export const appDomainFor = (env: "prod" | "staging", host: string) =>
  host.startsWith("admin.") && host.includes(".", 6)
    ? host.slice("admin.".length)
    : APP_DOMAIN[env];

/** Slug rules on the client, then (after a pause) the live check. */
function useSlugStatus(slug: string, domain: string) {
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
  if (local !== "ok")
    return { status: local, text: SLUG_COPY[local as "invalid" | "reserved"] };
  if (settled !== slug || remote.isFetching)
    return { status: "checking", text: "Checking..." };
  if (remote.isError)
    return { status: "unknown", text: "Could not check the name." };
  const s = remote.data?.status;
  if (s === "ok")
    return { status: "ok", text: `${slug}.${domain} is available.` };
  return {
    status: s ?? "unknown",
    text: s ? SLUG_COPY[s as keyof typeof SLUG_COPY] : null,
  };
}

export function CreateInstall() {
  const navigate = useNavigate();
  const releases = useQuery(releasesQuery());
  const installable = (releases.data?.items ?? []).filter((r) => r.installable);
  const latest = installable.find((r) => r.latest)?.version ?? "";
  const [slug, setSlug] = useState("");
  const [picked, setPicked] = useState("");
  const version = picked || latest;
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const domain = appDomainFor(
    me.data?.env ?? "prod",
    globalThis.location?.hostname ?? "",
  );
  const check = useSlugStatus(slug, domain);
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
  const slugTone =
    check.status === "ok"
      ? "ok"
      : check.status && BAD_SLUG.has(check.status)
        ? "bad"
        : null;
  /** Why Create install is off, shown next to it. */
  const blocker =
    check.status !== "ok"
      ? "Enter an available slug."
      : !emailOk
        ? "Enter the owner's email."
        : !auth.success
          ? "Pick a sign-in method and allowed domains."
          : !version
            ? "Pick a release."
            : null;
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
      // A retry after a dropped connection keeps its request id only while the body is the same.
      key: [slug, ownerEmail, tier, auth.data, version, sendWelcome],
      invalidate: [["installs"], ["world"]],
      onSuccess: (r) =>
        void navigate({ to: "/jobs/$id", params: { id: r.job.id } }),
    },
  );
  return (
    <>
      <p className="oa-crumbs">
        <Link to="/installs">Installs</Link> /
      </p>
      <h1>Create install</h1>
      <p className="oa-sub">
        Runs as a job. You can leave this page; it keeps going.
      </p>
      <div className="oa-split">
        <form
          className="oa-form"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className={slugTone ? `oa-field-${slugTone}` : undefined}>
            <Label htmlFor="slug">Slug</Label>
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
              className={slugTone ? `oa-help-${slugTone}` : undefined}
              role="status"
            >
              {check.text}
            </small>
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
            <small>Gets admin on the new workspace.</small>
          </div>
          <fieldset>
            <legend>Tier</legend>
            <div className="oa-seg">
              {TierSchema.options.map((t) => (
                <label key={t}>
                  <input
                    type="radio"
                    name="tier"
                    checked={tier === t}
                    onChange={() => setTier(t)}
                  />
                  {t[0].toUpperCase() + t.slice(1)}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Sign-in</legend>
            {AuthProviderSchema.options.map((p) => (
              <label key={p} className="oa-check">
                <input
                  type="checkbox"
                  checked={providers.includes(p)}
                  onChange={(e) =>
                    setProviders((cur) =>
                      e.target.checked
                        ? [...cur, p]
                        : cur.filter((x) => x !== p),
                    )
                  }
                />{" "}
                {p === "google" ? "Google" : "Email"}
              </label>
            ))}
            <label className="oa-sublabel" htmlFor="domains">
              Allowed domains
            </label>
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
          </fieldset>
          <div>
            <Label htmlFor="version">Release</Label>
            <select
              id="version"
              value={version}
              onChange={(e) => setPicked(e.target.value)}
            >
              {installable.map((r) => (
                <option key={r.version} value={r.version}>
                  {r.version}
                  {r.latest ? " (latest)" : ""}
                </option>
              ))}
            </select>
            <small>Only signed, published releases are listed.</small>
          </div>
          <label className="oa-check">
            <input
              type="checkbox"
              checked={sendWelcome}
              onChange={(e) => setSendWelcome(e.target.checked)}
            />{" "}
            Send the owner a welcome email
          </label>
          <ErrorLine error={create.error} />
          <div className="oa-actions oa-form-acts">
            <Button
              type="submit"
              aria-describedby={blocker ? "create-blocker" : undefined}
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
            <Link to="/installs" className="oa-btn">
              Cancel
            </Link>
          </div>
          {blocker && !create.isPending && (
            <small id="create-blocker" data-testid="create-blocker">
              {blocker}
            </small>
          )}
        </form>
        <aside className="oa-side" aria-label="What happens">
          <h2>What happens</h2>
          <ol>
            {visibleSteps(JOB_STEPS.create).map((s) => (
              <li key={s.id}>{s.label}</li>
            ))}
          </ol>
          <p className="oa-side-note">
            Nothing is reachable until "Route hosts". If a check fails, nothing
            is routed and the job says why.
          </p>
        </aside>
      </div>
    </>
  );
}
