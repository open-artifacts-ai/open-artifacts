import {
  AuthProviderSchema,
  AuthSchema,
  JOB_STEPS,
  slugRule,
  type Tier,
  TierSchema,
} from "@oa/shared/provisioning";
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { releasesQuery, slugQuery } from "../api/queries";
import { ErrorLine } from "../components/Bits";
import { providerLabel, TIER_LABEL, visibleSteps } from "../components/labels";
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
  if (!slug) return { status: null, text: `Becomes <slug>.${domain}` };
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
  // Untouched, the allowed domains are the owner's email domain.
  const [domainsText, setDomainsText] = useState<string | null>(null);
  const [sendWelcome, setSendWelcome] = useState(false);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail);
  const ownerDomain = emailOk
    ? (ownerEmail.split("@")[1] ?? "").toLowerCase()
    : "";
  const domainsValue = domainsText ?? ownerEmail.split("@")[1] ?? "";
  const domains = domainsValue
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const auth = AuthSchema.safeParse({
    providers: AuthProviderSchema.options.filter((p) => providers.includes(p)),
    domains,
  });
  const noProvider = providers.length === 0;
  /** Design's Allowed domains rules (option A): any method, owner's domain included. */
  const domainsError =
    domains.length === 0
      ? domainsText !== null || emailOk
        ? "Add at least one domain."
        : null
      : ownerDomain && !domains.includes(ownerDomain)
        ? `Include the owner's domain, ${ownerDomain}.`
        : null;
  const domainsOk = domains.length > 0 && !domainsError && auth.success;
  const slugTone =
    check.status === "ok"
      ? "ok"
      : check.status && BAD_SLUG.has(check.status)
        ? "bad"
        : null;
  /** Why Create install is off, shown beside it. */
  const blocker = !slug
    ? "Add a slug."
    : check.status !== "ok"
      ? "Pick an available slug."
      : !ownerEmail
        ? "Add an owner email."
        : !emailOk
          ? "Enter a valid owner email."
          : noProvider
            ? "Pick a sign-in method."
            : !domainsOk
              ? "Fix the allowed domains."
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
        <Link to="/installs">Installs</Link>
      </p>
      <h1>Create install</h1>
      <p className="oa-sub">
        Runs as a job. You can leave this page; it keeps going.
      </p>
      <div className="oa-split oa-create">
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
                  {TIER_LABEL[t]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset aria-describedby={noProvider ? "signin-error" : undefined}>
            <legend>Sign-in</legend>
            {AuthProviderSchema.options.map((p) => (
              <label key={p} className="oa-check" htmlFor={`signin-${p}`}>
                <Checkbox
                  id={`signin-${p}`}
                  checked={providers.includes(p)}
                  onCheckedChange={(on) =>
                    setProviders((cur) =>
                      on === true
                        ? [...cur.filter((x) => x !== p), p]
                        : cur.filter((x) => x !== p),
                    )
                  }
                />
                {providerLabel(p)}
              </label>
            ))}
            {noProvider && (
              <small
                id="signin-error"
                className="oa-help-bad"
                data-testid="signin-error"
              >
                Pick at least one.
              </small>
            )}
          </fieldset>
          <div className={domainsError ? "oa-field-bad" : undefined}>
            <Label htmlFor="domains">Allowed domains</Label>
            <Input
              id="domains"
              value={domainsValue}
              placeholder="example.com"
              autoComplete="off"
              aria-invalid={domainsError ? true : undefined}
              aria-describedby="domains-help"
              onChange={(e) => setDomainsText(e.target.value)}
            />
            <small
              id="domains-help"
              data-testid="domains-help"
              className={domainsError ? "oa-help-bad" : undefined}
            >
              {domainsError ??
                "People with an email at these domains can join. Starts with the owner's domain. Separate with commas."}
            </small>
          </div>
          <div>
            <Label htmlFor="version">Release</Label>
            <Select value={version} onValueChange={setPicked}>
              <SelectTrigger id="version" className="oa-release">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {installable.map((r) => (
                  <SelectItem key={r.version} value={r.version}>
                    <span className="oa-mono">{r.version}</span>
                    {r.latest && (
                      <>
                        {" "}
                        <span className="oa-latest">(latest)</span>
                      </>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <small>Only signed, published releases are listed.</small>
          </div>
          <label className="oa-check" htmlFor="welcome">
            <Checkbox
              id="welcome"
              checked={sendWelcome}
              onCheckedChange={(on) => setSendWelcome(on === true)}
            />
            Send the owner a welcome email
          </label>
          <ErrorLine error={create.error} />
          <div className="oa-actions oa-form-acts">
            <Button
              type="submit"
              aria-describedby={blocker ? "create-blocker" : undefined}
              disabled={!!blocker || create.isPending}
            >
              Create install
            </Button>
            <Link to="/installs" className="oa-btn">
              Cancel
            </Link>
            {blocker && !create.isPending && (
              <small
                id="create-blocker"
                data-testid="create-blocker"
                className="oa-blocker"
              >
                {blocker}
              </small>
            )}
          </div>
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
