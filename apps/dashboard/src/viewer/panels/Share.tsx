import {
  type ArtifactPatch,
  type ArtifactSummary,
  type DataWriters,
  type ShareRole,
  ShareSchema,
  type Visibility,
  viewerPath,
} from "@oa/shared";
import { displayName, VisibilityBadge } from "@oa/ui";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@oa/ui/shadcn";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { errorCopy } from "../../api/errorCopy";
import {
  useDeleteShare,
  usePatchArtifact,
  usePutShare,
  useShares,
} from "../../api/queries";
import { useSingleFlight } from "../../api/useSingleFlight";
import { emailEnabled } from "../../auth/emailEnabled";
import { useCan } from "../../auth/permissions";
import { useMe } from "../../auth/useMe";
import { ConflictNote, isConflict } from "../../layout/ConflictNote";
import { CopyLink } from "../../layout/CopyLink";
import { LabelledCheckbox } from "../../layout/LabelledCheckbox";
import { Modal } from "../../layout/Modal";
import { Notice } from "../../layout/Notice";
import { toast } from "../../layout/toast";
import { UserAvatar } from "../../layout/UserAvatar";
import { visibilityHint } from "../../spaces/SpaceMarker";

const VIS: { value: Visibility; label: string }[] = [
  { value: "private", label: "Private" },
  { value: "team", label: "Team" },
  { value: "public", label: "Public" },
];
const ROLES: { value: ShareRole; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];
const NOTE: Record<Visibility, string> = {
  private: "Only you and the people below can open it.",
  team: "Everyone in the workspace can open it.",
  public: "Anyone with the link can view. It won't appear in search engines.",
};
/** #681: who may change the page's live data. */
const WRITERS: { value: DataWriters; label: string }[] = [
  { value: "viewers", label: "Everyone who can see it" },
  { value: "editors", label: "Only editors" },
];
const writersHint = (w: DataWriters, v: Visibility) =>
  w === "editors"
    ? "Only you and people who can edit it."
    : v === "public"
      ? "Anyone with the link, signed in or not."
      : "Anyone who can view it.";

const CAPS = [
  ["db", "Database", "Lets the page store shared data."],
  ["viewer", "Viewer identity", "Lets the page see who is viewing."],
  ["storage", "File storage", "Lets the page keep uploaded files."],
] as const;

const fail = (e: unknown, fallback: string) =>
  toast({
    title: e instanceof ApiClientError ? e.message : fallback,
    tone: "danger",
  });
/** A refused visibility change: Design's copy for hosted codes (public_links_off), else the server's words. */
const failVisibility = (e: unknown) =>
  e instanceof ApiClientError && e.code === "public_links_off"
    ? toast({
        title: "Couldn't save",
        description: errorCopy(e, ""),
        tone: "danger",
      })
    : fail(e, "Couldn't save");

/** Trimmed, lowercased, ASCII-only email, or null. */
export const parseEmail = (raw: string) => {
  const v = raw.trim().toLowerCase();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII check
  if (!/^[\x00-\x7f]+$/.test(v)) return null;
  const r = ShareSchema.shape.email.safeParse(v);
  return r.success ? r.data : null;
};

const TEXT = "text-[length:var(--oa-text-sm)]";
const CONTROL = `h-[30px] ${TEXT}`;
const H3 = "mb-[6px] text-[length:var(--oa-text-sm)] font-semibold";
const MUTED = "text-muted-foreground";
const PERSON = "flex items-center gap-[var(--oa-space-2)]";
const NAME = "min-w-0 flex-1 truncate";

function RoleSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ShareRole;
  onChange: (r: ShareRole) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ShareRole)}>
      <SelectTrigger
        aria-label={label}
        size="sm"
        className={`w-[96px] flex-none ${TEXT}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {ROLES.map((r) => (
          <SelectItem key={r.value} value={r.value} className={TEXT}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Share({ artifact }: { artifact: ArtifactSummary }) {
  const { id } = artifact;
  const can = useCan(artifact);
  const vis = can.setVisibility;
  const people = can.share;
  // Q7: a space with public links off blocks new ones; one that's already
  // public keeps working, so Public stays available to it.
  const space = artifact.space;
  const publicOff =
    space?.publicLinks === false && artifact.visibility !== "public";
  const shares = useShares(id, people);
  const patch = usePatchArtifact(id);
  const put = usePutShare(id);
  const del = useDeleteShare(id);
  const [confirmPublic, setConfirmPublic] = useState(false);
  // A 409 on a visibility change: the choice reverts to the server's value.
  const [conflict, setConflict] = useState(false);
  // The control only stages a choice; Save visibility commits it.
  // Tagged with the visibility it was staged from, so a server change drops it.
  const [stage, setStage] = useState<{
    from: Visibility;
    to: Visibility;
  } | null>(null);
  const setPending = (to: Visibility | null) => {
    setStage(to && { from: artifact.visibility, to });
    if (to) setConflict(false);
  };
  const staged =
    stage?.from === artifact.visibility ? stage.to : artifact.visibility;
  const changed = staged !== artifact.visibility;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [invalid, setInvalid] = useState(false);
  const [shared, setShared] = useState<{
    email: string;
    emailed: boolean;
  } | null>(null);
  const state = useMe();
  const install = state.status === "authed" ? state.me.instance.name : "";
  const sends = emailEnabled(state.status === "authed" ? state.me : null);

  const save = (p: ArtifactPatch) =>
    patch.mutate(p, { onError: (e) => fail(e, "Couldn't save") });
  // One request per action: a double click or Enter can't send two.
  const visOnce = useSingleFlight();
  const inviteOnce = useSingleFlight();
  const removeOnce = useSingleFlight();
  const commitVisibility = (v: Visibility) =>
    visOnce((done) =>
      patch.mutate(
        { visibility: v },
        {
          onSettled: done,
          onSuccess: () => setConflict(false),
          onError: (e) => {
            setPending(null);
            if (isConflict(e)) return setConflict(true);
            failVisibility(e);
          },
        },
      ),
    );
  // Turning db off keeps dataWriters as set: it shows again when db is back.
  const setCap = (k: (typeof CAPS)[number][0], on: boolean) =>
    save({ capabilities: { [k]: on } });
  const invite = () => {
    const e = parseEmail(email);
    setInvalid(!e);
    if (!e) return;
    inviteOnce((done) =>
      put.mutate(
        { email: e, role },
        {
          onSettled: done,
          onSuccess: (r) => {
            setEmail("");
            setShared({ email: e, emailed: r.emailed });
          },
          onError: (x) => fail(x, "Couldn't share"),
        },
      ),
    );
  };
  // location.origin is the app host, which is where viewerPath lives.
  const link = location.origin + viewerPath(id);
  const copy = () => {
    const failed = () =>
      toast({
        title: "Couldn't copy",
        // One click selects the whole link, to copy by hand.
        description: <span className="select-all">{link}</span>,
        tone: "danger",
      });
    if (!navigator.clipboard) return failed();
    navigator.clipboard
      .writeText(link)
      .then(() => toast({ title: "Link copied", tone: "success" }), failed);
  };

  return (
    <div className="oa-share flex flex-col gap-[var(--oa-space-4)]">
      {/* #189/#193: toggle, helper text 8px below, then the action row 16px
          after it. The accent marks the chosen visibility. */}
      <section>
        <h3 id="oa-share-vis" className={H3}>
          Visibility
        </h3>
        {vis ? (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Visibility"
            value={staged}
            onValueChange={(v) =>
              v && !patch.isPending && setPending(v as Visibility)
            }
          >
            {VIS.map((o) => (
              <ToggleGroupItem
                key={o.value}
                value={o.value}
                disabled={o.value === "public" && publicOff}
                aria-describedby={
                  o.value === "public" && space?.publicLinks === false
                    ? "oa-share-public-off"
                    : undefined
                }
                className={`px-[var(--oa-space-3)] ${CONTROL}`}
                // Radio semantics: arrowing to an option chooses it, as the
                // radiogroup role promises (Radix only moves focus).
                // TODO: drop once Design's ToggleGroup primitive selects on arrow.
                onFocus={() => !patch.isPending && setPending(o.value)}
              >
                {o.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <VisibilityBadge visibility={artifact.visibility} />
        )}
        <p className={`oa-vis-note mt-[var(--oa-space-2)] ${MUTED}`}>
          {/* Hosted: the help text names the space or the org (D6 section 9). */}
          {visibilityHint(staged, artifact.space, install) ?? NOTE[staged]}
        </p>
        {conflict && (
          <div className="mt-[var(--oa-space-2)]">
            <ConflictNote />
          </div>
        )}
        {space?.publicLinks === false && (
          <p
            id="oa-share-public-off"
            className={`mt-[var(--oa-space-1)] ${MUTED}`}
          >
            Public links are off for {space.name}. A space manager can turn them
            on.
          </p>
        )}
        {vis && changed && (
          <div className="mt-[var(--oa-space-4)] flex items-center gap-[var(--oa-space-2)]">
            <Button
              size="sm"
              className={CONTROL}
              disabled={patch.isPending}
              aria-busy={patch.isPending || undefined}
              onClick={() =>
                staged === "public"
                  ? setConfirmPublic(true)
                  : commitVisibility(staged)
              }
            >
              Save visibility
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={CONTROL}
              disabled={patch.isPending}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
          </div>
        )}
      </section>

      {people && (
        <section>
          <h3 className={H3}>Add people</h3>
          <form
            className="flex flex-wrap items-center gap-[var(--oa-space-2)]"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              invite();
            }}
          >
            <Input
              type="email"
              aria-label="Email"
              placeholder="name@example.com"
              value={email}
              aria-invalid={invalid}
              className={`basis-full ${CONTROL} md:${TEXT}`}
              onChange={(e) => {
                setEmail(e.target.value);
                setInvalid(false);
              }}
            />
            <RoleSelect label="Invite role" value={role} onChange={setRole} />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className={CONTROL}
              disabled={put.isPending}
              aria-busy={put.isPending || undefined}
            >
              Add
            </Button>
          </form>
          {invalid && (
            <p
              role="alert"
              className="mt-[var(--oa-space-2)] mb-0 text-destructive"
            >
              Enter a valid email address.
            </p>
          )}
          <p className={`mt-[var(--oa-space-3)] ${MUTED}`}>
            {sends
              ? "We'll email them a link. You can also copy it and send it yourself."
              : "No email is sent. Copy the link and share it yourself."}
          </p>
        </section>
      )}

      <section>
        {shared && (
          <div className="mb-[var(--oa-space-4)] [&_p]:mb-[var(--oa-space-2)]">
            <Notice
              tone="success"
              title={`Shared with ${shared.email}`}
              onDismiss={() => setShared(null)}
            >
              <p>
                {shared.emailed
                  ? "We emailed them a link. They'll sign in with a one-time code."
                  : artifact.visibility === "public"
                    ? "Send them this link. They can open it without signing in."
                    : "Send them this link. They'll sign in with a one-time code sent to that address, then see the artifact."}
              </p>
              {/* emailed:false with email on is not a failure here: members and
                  re-shares are never emailed, so there's no "didn't send" line. */}
              <CopyLink link={link} label="Artifact link" />
            </Notice>
          </div>
        )}
        <h3 className={H3}>People</h3>
        <ul className="flex flex-col gap-[var(--oa-space-2)] p-0">
          <li className={PERSON}>
            <UserAvatar
              name={artifact.owner.name}
              email={artifact.owner.email}
            />
            <span className={NAME} title={displayName(artifact.owner)}>
              {displayName(artifact.owner)}
            </span>
            <span className="text-muted-foreground">Owner</span>
          </li>
          {(people ? (shares.data ?? []) : []).map((s) => (
            <li key={s.email} className={PERSON}>
              <UserAvatar name={null} email={s.email} />
              <span className={NAME} title={s.email}>
                {s.email}
              </span>
              {people ? (
                <>
                  <RoleSelect
                    label={`Role for ${s.email}`}
                    value={s.role}
                    onChange={(r) =>
                      put.mutate(
                        { email: s.email, role: r },
                        { onError: (x) => fail(x, "Couldn't change role") },
                      )
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-[30px] flex-none p-0"
                    aria-label={`Remove ${s.email}`}
                    onClick={() =>
                      removeOnce((done) =>
                        del.mutate(s.email, {
                          onSettled: done,
                          onError: (x) => fail(x, "Couldn't remove"),
                        }),
                      )
                    }
                  >
                    ×
                  </Button>
                </>
              ) : (
                <span className="text-muted-foreground">{s.role}</span>
              )}
            </li>
          ))}
        </ul>
        {!people && (
          <p className="oa-muted">
            Only people who can share this artifact see who else has access.
          </p>
        )}
      </section>

      <section>
        <h3 className={H3}>Live data</h3>
        {CAPS.map(([k, label, hint]) => (
          <div className="oa-cap" key={k}>
            <LabelledCheckbox
              id={`oa-cap-${k}`}
              describedBy={`oa-cap-${k}-hint`}
              label={label}
              checked={artifact.capabilities[k]}
              disabled={!vis || patch.isPending}
              onCheckedChange={(on) => setCap(k, on)}
            />
            <small id={`oa-cap-${k}-hint`} className="oa-muted">
              {hint}
            </small>
          </div>
        ))}
        {artifact.capabilities.db && (
          <div className="oa-cap">
            <p id="oa-share-writers" className="font-medium">
              Who can change the live data
            </p>
            {vis ? (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                aria-labelledby="oa-share-writers"
                aria-describedby="oa-share-writers-hint"
                value={artifact.dataWriters}
                onValueChange={(w) =>
                  w &&
                  w !== artifact.dataWriters &&
                  !patch.isPending &&
                  save({ dataWriters: w as DataWriters })
                }
              >
                {WRITERS.map((o) => (
                  <ToggleGroupItem
                    key={o.value}
                    value={o.value}
                    disabled={patch.isPending}
                    className={`px-[var(--oa-space-3)] ${CONTROL}`}
                  >
                    {o.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : (
              <p>
                {WRITERS.find((o) => o.value === artifact.dataWriters)?.label}
              </p>
            )}
            <small id="oa-share-writers-hint" className="oa-muted">
              {writersHint(artifact.dataWriters, artifact.visibility)}
            </small>
          </div>
        )}
      </section>

      <Button
        variant="outline"
        size="sm"
        className={`w-full ${CONTROL}`}
        onClick={copy}
      >
        Copy link
      </Button>

      <Modal
        open={confirmPublic}
        onClose={() => setConfirmPublic(false)}
        title="Make this public?"
        description="Anyone with the link can view. It won't appear in search engines."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmPublic(false);
                setPending(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmPublic(false);
                commitVisibility("public");
              }}
            >
              Make public
            </Button>
          </>
        }
      />
    </div>
  );
}
