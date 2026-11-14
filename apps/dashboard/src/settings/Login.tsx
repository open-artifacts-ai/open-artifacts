// #2520, Settings > Login (owners and admins): how people log in, who can get
// in (invites, and the domain join), and what members and guests are. Design's
// screens A and B. The data is PROVISIONAL (api/loginSettings.ts).
import { Badge } from "@oa/ui/shadcn";
import { type ReactNode, useState } from "react";
import { type LoginSettings, useLoginSettings } from "../api/loginSettings";
import { useMe } from "../auth/useMe";
import { LoadError } from "../layout/LoadError";
import { Notice } from "../layout/Notice";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { ConfirmDialog } from "./ConfirmDialog";
import { useDomainJoin } from "./domainJoin";
import { AUTH_DOMAINS_DOC, DOMAIN_OFF, DOMAIN_ON, LOGIN } from "./loginCopy";
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

export function Login() {
  useDocumentTitle("Login");
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const q = useLoginSettings(!!me);
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
  if (!q.data) return null;
  const s = q.data;
  // A capped owner acts as an admin, as on Members.
  const owner = me.user.role === "owner" && me.auth?.cap == null;
  return (
    <div className={STACK}>
      <Methods s={s} instance={me.instance.name} />
      {s.scope !== "solo" && <Who s={s} owner={owner} />}
      {s.scope !== "solo" && <Roles />}
    </div>
  );
}

function Methods({ s, instance }: { s: LoginSettings; instance: string }) {
  const pill = (on: boolean) => (
    <Pill tone={on ? "ok" : "plain"}>{on ? LOGIN.pillOn : LOGIN.pillOff}</Pill>
  );
  return (
    <SettingsCard
      id="oa-login-methods"
      title={LOGIN.methodsTitle}
      subtitle={LOGIN.methodsSub(instance)}
    >
      <Row id="google" title={LOGIN.google} end={pill(s.methods.google)}>
        <Line>{LOGIN.googleLine}</Line>
      </Row>
      <Row id="email" title={LOGIN.email} end={pill(s.methods.email)}>
        <Line>{LOGIN.emailLine}</Line>
      </Row>
      <p className={`m-0 ${muted}`}>{LOGIN.methodsNote}</p>
    </SettingsCard>
  );
}

function Who({ s, owner }: { s: LoginSettings; owner: boolean }) {
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
      <DomainRow s={s} owner={owner} />
    </SettingsCard>
  );
}

function DomainRow({ s, owner }: { s: LoginSettings; owner: boolean }) {
  const d = s.domain;
  const [asking, setAsking] = useState<"on" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const join = useDomainJoin({ onError: setError });

  if (s.scope === "self_hosted")
    return (
      <Row
        id="domain"
        title={LOGIN.domain}
        end={<Pill tone="plain">{LOGIN.pillSetup}</Pill>}
      >
        <Line>{LOGIN.domainLine}</Line>
        <Line>{LOGIN.selfHosted}</Line>
        {d.name && (
          <div>
            <DomainChip name={d.name} />
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

  if (d.unavailable || !d.name)
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

  const name = d.name;
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
              checked={d.enabled}
              disabled={join.busy}
              describedBy="oa-login-domain-state"
              onChange={(next) => {
                setError(null);
                setAsking(next ? "on" : "off");
              }}
            />
          ) : (
            <Pill tone={d.enabled ? "ok" : "plain"}>
              {d.enabled ? LOGIN.pillOn : LOGIN.pillOff}
            </Pill>
          )
        }
      >
        <Line>{LOGIN.domainLine}</Line>
        <div>
          <DomainChip name={name} muted={!d.enabled} />
        </div>
        <Line id="oa-login-domain-state">
          {d.enabled ? LOGIN.domainFrom : LOGIN.domainOff}
        </Line>
        {error && (
          <p role="alert" className={`m-0 ${errorText}`}>
            {error}
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
        onConfirm={() => join.change({ domainJoin: true })}
      />
      <ConfirmDialog
        open={asking === "off"}
        onClose={() => setAsking(null)}
        title={DOMAIN_OFF.title(name)}
        body={<p className="m-0">{DOMAIN_OFF.body(name, d.joined)}</p>}
        confirm={DOMAIN_OFF.confirm}
        onConfirm={() => join.change({ domainJoin: false })}
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
