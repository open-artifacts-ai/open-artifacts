// #2520, Settings > Login (owners and admins): how people log in, who can get
// in (invites, and the domain join), and what members and guests are. Design's
// screens A and B. The data is PROVISIONAL (api/loginSettings.ts).
import type { Me } from "@oa/shared";
import { Badge } from "@oa/ui/shadcn";
import { type ReactNode, useState } from "react";
import { useAuthProviders } from "../api/auth";
import { type LoginSettings, useLoginSettings } from "../api/loginSettings";
import { useMe } from "../auth/useMe";
import { LoadError } from "../layout/LoadError";
import { Notice } from "../layout/Notice";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { ConfirmDialog } from "./ConfirmDialog";
import { joinBody, useDomainJoin } from "./domainJoin";
import {
  AUTH_DOMAINS_DOC,
  DOMAIN_OFF,
  DOMAIN_ON,
  LOGIN,
  SAVE,
} from "./loginCopy";
import { Switch } from "./spaces/Switch";
import { errorText, muted, SettingsCard, STACK } from "./ui";

const TONE = {
  ok: "border-transparent bg-[var(--oa-success-soft)] text-[var(--oa-success)]",
  warn: "border-transparent bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]",
  plain: "text-muted-foreground",
} as const;

export function Pill({
  tone,
  children,
}: {
  tone: keyof typeof TONE;
  children: string;
}) {
  return (
    <Badge variant="outline" className={`flex-none ${TONE[tone]}`}>
      {children}
    </Badge>
  );
}

/** The domain, as a chip; muted while the join is off. Long names wrap. */
export function DomainChip({
  name,
  muted: dim,
}: {
  name: string;
  muted?: boolean;
}) {
  return (
    <span
      className={`inline-block max-w-full rounded-sm border border-border px-[6px] py-[1px] font-mono text-[length:var(--oa-text-xs)] [overflow-wrap:anywhere] ${dim ? "text-muted-foreground" : "bg-secondary text-foreground"}`}
    >
      {name}
    </span>
  );
}

/** Title and lines on the left, the pill or switch at the right edge (phones too). */
function Row({
  id,
  title,
  children,
  end,
}: {
  id: string;
  title: string;
  children?: ReactNode;
  end?: ReactNode;
}) {
  return (
    <div
      data-row={id}
      className="flex items-start justify-between gap-[var(--oa-space-3)] border-0 border-t border-border pt-[var(--oa-space-3)] first:border-t-0 first:pt-0"
    >
      <div className="grid min-w-0 gap-[2px]">
        <b
          id={`oa-login-${id}`}
          className="text-[length:var(--oa-text-sm)] font-medium"
        >
          {title}
        </b>
        {children}
      </div>
      {end && <div className="flex flex-none items-center pt-[1px]">{end}</div>}
    </div>
  );
}

const Line = ({ children, id }: { children: ReactNode; id?: string }) => (
  <p id={id} className={`m-0 ${muted}`}>
    {children}
  </p>
);

/** What the page shows, derived from the settings and what the app knows. */
export type LoginView = {
  scope: "team" | "solo" | "self_hosted";
  methods: { google: boolean; email: boolean };
  /** The domain the switch is about; null when there is none (a Gmail owner). */
  domain: string | null;
};

export const loginView = (
  s: LoginSettings,
  me: Me,
  providers: readonly string[],
): LoginView => ({
  scope: !s.editable
    ? "self_hosted"
    : me.instance.billing?.tier === "solo"
      ? "solo"
      : "team",
  methods: {
    google: providers.includes("google"),
    email: providers.includes("email"),
  },
  domain: s.provable ?? s.domains[0] ?? null,
});

export function Login() {
  useDocumentTitle("Login");
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const q = useLoginSettings(!!me);
  const providers = useAuthProviders(!!me);
  if (!me) return null;
  if (q.isError)
    return (
      <LoadError
        title="Couldn't load login settings."
        error={q.error}
        onRetry={() => void q.refetch()}
        busy={q.isFetching}
      />
    );
  if (!q.data || !providers.data) return null;
  const s = q.data;
  const v = loginView(
    s,
    me,
    providers.data.providers.map((p) => p.id),
  );
  // A capped owner acts as an admin, as on Members.
  const owner = me.user.role === "owner" && me.auth?.cap == null;
  return (
    <div className={STACK}>
      <Methods v={v} instance={me.instance.name} />
      {v.scope !== "solo" && <Who s={s} v={v} owner={owner} />}
      {v.scope !== "solo" && <Roles />}
    </div>
  );
}

function Methods({ v, instance }: { v: LoginView; instance: string }) {
  const pill = (on: boolean) => (
    <Pill tone={on ? "ok" : "plain"}>{on ? LOGIN.pillOn : LOGIN.pillOff}</Pill>
  );
  return (
    <SettingsCard
      id="oa-login-methods"
      title={LOGIN.methodsTitle}
      subtitle={LOGIN.methodsSub(instance)}
    >
      <Row id="google" title={LOGIN.google} end={pill(v.methods.google)}>
        <Line>{LOGIN.googleLine}</Line>
      </Row>
      <Row id="email" title={LOGIN.email} end={pill(v.methods.email)}>
        <Line>{LOGIN.emailLine}</Line>
      </Row>
      <p className={`m-0 ${muted}`}>{LOGIN.methodsNote}</p>
    </SettingsCard>
  );
}

function Who({
  s,
  v,
  owner,
}: {
  s: LoginSettings;
  v: LoginView;
  owner: boolean;
}) {
  return (
    <SettingsCard
      id="oa-login-who"
      title={LOGIN.whoTitle}
      subtitle={LOGIN.whoSub}
    >
      <Row
        id="invited"
        title={LOGIN.invited}
        end={<Pill tone="ok">{LOGIN.pillAlways}</Pill>}
      >
        <Line>{LOGIN.invitedLine}</Line>
      </Row>
      <DomainRow s={s} v={v} owner={owner} />
    </SettingsCard>
  );
}

const SAVE_LINE = {
  pending: SAVE.pending,
  saved: SAVE.saved,
  failed: SAVE.failed,
} as const;

function DomainRow({
  s,
  v,
  owner,
}: {
  s: LoginSettings;
  v: LoginView;
  owner: boolean;
}) {
  const [asking, setAsking] = useState<"on" | "off" | null>(null);
  const join = useDomainJoin();

  if (v.scope === "self_hosted")
    return (
      <Row
        id="domain"
        title={LOGIN.domain}
        end={<Pill tone="plain">{LOGIN.pillSetup}</Pill>}
      >
        <Line>{LOGIN.domainLine}</Line>
        <Line>{LOGIN.selfHosted}</Line>
        {s.domains.length > 0 && (
          <div className="flex flex-wrap gap-[var(--oa-space-1)]">
            {s.domains.map((d) => (
              <DomainChip key={d} name={d} />
            ))}
          </div>
        )}
        <Line>
          {LOGIN.selfHostedChange} <code>{LOGIN.selfHostedFlag}</code>{" "}
          {LOGIN.selfHostedAt}{" "}
          <a
            href={AUTH_DOMAINS_DOC}
            target="_blank"
            rel="noopener"
            className="underline"
          >
            {LOGIN.selfHostedHow}
          </a>
        </Line>
      </Row>
    );

  if (!v.domain)
    return (
      <Row
        id="domain"
        title={LOGIN.domain}
        end={
          <Switch
            label={LOGIN.domain}
            checked={false}
            disabled
            describedBy="oa-login-domain-why"
            onChange={() => {}}
          />
        }
      >
        <Line>{LOGIN.domainLine}</Line>
        <Line id="oa-login-domain-why">{LOGIN.unavailable}</Line>
      </Row>
    );

  const name = v.domain;
  const note = join.state in SAVE_LINE ? join.state : null;
  return (
    <>
      <Row
        id="domain"
        title={LOGIN.domain}
        end={
          owner ? (
            <Switch
              id="oa-login-domain-switch"
              label={LOGIN.domain}
              checked={s.autoJoin}
              disabled={join.busy}
              describedBy="oa-login-domain-state"
              onChange={(next) => setAsking(next ? "on" : "off")}
            />
          ) : (
            <Pill tone={s.autoJoin ? "ok" : "plain"}>
              {s.autoJoin ? LOGIN.pillOn : LOGIN.pillOff}
            </Pill>
          )
        }
      >
        <Line>{LOGIN.domainLine}</Line>
        <div className="flex flex-wrap gap-[var(--oa-space-1)]">
          <DomainChip name={name} muted={!s.autoJoin} />
        </div>
        <Line id="oa-login-domain-state">
          {s.autoJoin ? LOGIN.domainFrom : LOGIN.domainOff}
        </Line>
        {note && (
          <p
            role={note === "failed" ? "alert" : "status"}
            className={`m-0 ${note === "failed" ? errorText : muted}`}
          >
            {SAVE_LINE[note as keyof typeof SAVE_LINE]}
          </p>
        )}
      </Row>
      <ConfirmDialog
        open={asking === "on"}
        onClose={() => setAsking(null)}
        title={DOMAIN_ON.title(name)}
        body={
          <>
            <p className="m-0">{DOMAIN_ON.body(name)}</p>
            <Notice tone="warning" compact>
              {DOMAIN_ON.warn}
            </Notice>
            <p className={`m-0 ${muted}`}>{DOMAIN_ON.again}</p>
          </>
        }
        confirm={DOMAIN_ON.confirm}
        onConfirm={() => join.change(joinBody(s, true))}
      />
      <ConfirmDialog
        open={asking === "off"}
        onClose={() => setAsking(null)}
        title={DOMAIN_OFF.title(name)}
        // The joined count isn't in #2520's API draft yet.
        body={<p className="m-0">{DOMAIN_OFF.body(name, null)}</p>}
        confirm={DOMAIN_OFF.confirm}
        onConfirm={() => join.change(joinBody(s, false))}
      />
    </>
  );
}

function Roles() {
  const box = (title: string, line: string) => (
    <div className="grid content-start gap-[2px] rounded-md border border-border p-[var(--oa-space-3)]">
      <b className="text-[length:var(--oa-text-sm)] font-medium">{title}</b>
      <p className={`m-0 ${muted}`}>{line}</p>
    </div>
  );
  return (
    <SettingsCard id="oa-login-roles" title={LOGIN.rolesTitle}>
      <div className="grid grid-cols-2 gap-[var(--oa-space-3)] max-[600px]:grid-cols-1">
        {box(LOGIN.member, LOGIN.memberLine)}
        {box(LOGIN.guest, LOGIN.guestLine)}
      </div>
    </SettingsCard>
  );
}
