import { PublishResultSchema, R } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { api } from "../api/client";
import { toast } from "../layout/toast";
import { markFresh, NEW_DOC_TOAST } from "../viewer/doc/fresh";

/** Where "See hosted plans" goes. */
const HOSTED_URL = "https://open-artifacts.com";
/** Where "How to turn on Workers Paid" goes (Product). */
const PAID_URL = "https://open-artifacts.com/docs/self-hosting-costs";

/** The agent line under the tabs (Design, docs mockup step 1). */
export const AGENT_LINE =
  'Your agents can make docs too. Ask one: "Create a doc called Launch plan."';

const PlusIcon = () => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M8 3v10M3 8h10" />
  </svg>
);

/**
 * The Library's New doc button (#1100). On: creates a blank doc and opens it.
 * Needs paid (a self-host on Workers Free): the button stays, and pressing it
 * brings the note into view.
 */
export function NewDocButton({
  docs,
  spaceId,
  onGate,
}: {
  docs: "on" | "needs_paid";
  spaceId?: string;
  onGate: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (docs === "needs_paid") {
      onGate();
      toast({
        title: "New doc is off on this instance. The note says why.",
        tone: "warning",
      });
      return;
    }
    setBusy(true);
    try {
      const made = await api.send(
        "POST",
        R.artifacts,
        {
          format: "doc",
          title: "Untitled",
          content: "",
          ...(spaceId ? { spaceId } : {}),
        },
        PublishResultSchema,
      );
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
      markFresh(made.id);
      await navigate({ to: `/a/${made.id}` } as never);
      toast({
        title: "Type a title, then press Enter to start writing.",
        tone: "neutral",
        id: NEW_DOC_TOAST,
      });
    } catch (e) {
      toast({
        title: "Couldn't create the doc.",
        description: e instanceof Error ? e.message : undefined,
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      disabled={busy}
      // Off, but still pressable: it brings the note into view.
      aria-disabled={docs === "needs_paid" ? true : undefined}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      onClick={() => void create()}
    >
      <PlusIcon />
      New doc
    </Button>
  );
}

/** The note where New doc would work: docs need Workers Paid on a self-host. */
export function DocsGate({
  gateRef,
}: {
  gateRef: React.RefObject<HTMLElement | null>;
}) {
  return (
    <section
      ref={gateRef}
      tabIndex={-1}
      aria-labelledby="docs-gate-title"
      className="max-w-[640px] rounded-lg border border-border border-l-[3px] border-l-[var(--oa-warning)] bg-card p-[var(--oa-space-3)] outline-none focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)]"
    >
      <h2
        id="docs-gate-title"
        className="mb-[4px] text-[length:var(--oa-text-md)] font-semibold"
      >
        Docs need Cloudflare's Workers Paid plan
      </h2>
      <p className="mb-[8px] text-[length:var(--oa-text-sm)] text-[var(--oa-text-2)]">
        Collaborative docs need Cloudflare's Workers Paid plan when you
        self-host. Or use hosted Open Artifacts: Solo is $1 a month.
      </p>
      <p className="mb-[8px] text-[length:var(--oa-text-sm)] text-[var(--oa-text-2)]">
        Everything else works as before: pages, files, comments and what your
        agents publish.
      </p>
      <div className="flex flex-wrap gap-[var(--oa-space-2)]">
        <Button asChild size="sm">
          <a href={PAID_URL} target="_blank" rel="noopener noreferrer">
            How to turn on Workers Paid
          </a>
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={HOSTED_URL} target="_blank" rel="noopener noreferrer">
            See hosted plans
          </a>
        </Button>
      </div>
    </section>
  );
}

/** The gate's ref and a "show it" callback. */
export function useGate() {
  const ref = useRef<HTMLElement | null>(null);
  return {
    ref,
    show: () => {
      ref.current?.scrollIntoView({ block: "nearest" });
      ref.current?.focus();
    },
  };
}
