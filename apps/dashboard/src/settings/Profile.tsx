import type { Me } from "@oa/shared";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  Input,
  Label,
} from "@oa/ui/shadcn";
import { useState } from "react";
import { useUpdateMe } from "../api/queries";
import { useSingleFlight } from "../api/useSingleFlight";
import {
  NAME_MAX,
  nameLength,
  nameOk,
  saveError,
  TOO_LONG,
} from "../auth/displayName";
import { useMe } from "../auth/useMe";
import { toast } from "../layout/toast";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { CARD, INSET } from "./ui";

export function Profile() {
  useDocumentTitle("Profile");
  const state = useMe();
  if (state.status !== "authed") return null;
  return <ProfileForm key={state.me.user.id} me={state.me} />;
}

function ProfileForm({ me }: { me: Me }) {
  const saved = me.displayName ?? "";
  // null: not edited, so it reads through from the server.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const update = useUpdateMe();
  const once = useSingleFlight();
  const name = draft ?? me.displayName ?? me.suggestedName ?? "";
  const trimmed = name.trim();
  const dirty = trimmed !== saved;
  const tooLong = nameLength(trimmed) > NAME_MAX;
  const hidden = me.nameHiddenAs ?? null;
  const problem = error ?? (tooLong ? TOO_LONG : null);
  return (
    <section className="max-w-[460px]" aria-label="Profile">
      <Card className={CARD}>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty || !nameOk(trimmed) || update.isPending) return;
            setError(null);
            once((done) =>
              update.mutate(
                { displayName: trimmed },
                {
                  onSuccess: () => {
                    setDraft(null);
                    setJustSaved(true);
                    toast({ title: "Display name saved", tone: "success" });
                  },
                  onError: (err) => setError(saveError(err)),
                  onSettled: done,
                },
              ),
            );
          }}
        >
          <CardContent className={`grid gap-3 ${INSET}`}>
            <div className="grid gap-1.5">
              <Label htmlFor="oa-profile-name">Display name</Label>
              <Input
                id="oa-profile-name"
                value={name}
                placeholder="Your full name"
                autoComplete="name"
                aria-invalid={Boolean(problem) || undefined}
                aria-describedby={[
                  problem && "oa-profile-name-err",
                  hidden && "oa-profile-name-hidden",
                  "oa-profile-name-help",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                  setJustSaved(false);
                }}
              />
              {problem && (
                <p
                  id="oa-profile-name-err"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {problem}
                </p>
              )}
              {hidden && (
                <p
                  id="oa-profile-name-hidden"
                  className="text-xs text-muted-foreground"
                >
                  Others see your {hidden === "sso" ? "sign-in name" : "email"}{" "}
                  instead of this name, because it looks like an agent's name.
                  Pick a different display name to show it.
                </p>
              )}
              <p
                id="oa-profile-name-help"
                className="text-xs text-muted-foreground"
              >
                Shown on invites and shared artifacts.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="oa-profile-email">Email</Label>
              <Input
                id="oa-profile-email"
                value={me.user.email}
                readOnly
                className="border-transparent bg-muted text-muted-foreground shadow-none"
              />
            </div>
          </CardContent>
          <CardFooter
            className={`justify-between border-t ${INSET} [.border-t]:pt-(--oa-space-5) max-[600px]:[.border-t]:pt-(--oa-space-4)`}
          >
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {dirty ? "Unsaved changes" : justSaved ? "Saved" : ""}
            </span>
            <Button
              type="submit"
              disabled={!dirty || !nameOk(trimmed) || update.isPending}
            >
              Save
            </Button>
          </CardFooter>
        </form>
      </Card>
    </section>
  );
}
