import type { Me } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { qk, useInviteMember } from "../src/api/queries";
import { installHarness, mount, mountHosted, page, server } from "./harness";

installHarness();

const none = () => http.get("*/api/v1/artifacts", () => page([], null));
const noTokens = () => [
  http.get("*/api/v1/tokens", () => HttpResponse.json([])),
  http.get("*/api/v1/oauth-clients", () => HttpResponse.json([])),
  http.get("*/api/v1/members", () =>
    HttpResponse.json(fixtures.members.filter((m) => m.role === "owner")),
  ),
];
const owner = (m: Me): Me => ({ ...m, user: { ...m.user, role: "owner" } });
const billing = (over: Record<string, unknown>) => (m: Me) => {
  const o = owner(m);
  return {
    ...o,
    instance: {
      ...o.instance,
      billing: {
        tier: "solo",
        status: "active",
        trialEndsAt: null,
        graceUntil: null,
        readOnly: false,
        reason: "solo",
        ...over,
      },
    } as Me["instance"],
  };
};
const trialLine = /30-day Team trial/;
const heading = () => screen.findByRole("heading", { name: "Get started" });

describe("Get started checklist", () => {
  it("shows the three steps to the owner with the setup prompt", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    expect(screen.getByText("0 of 3")).toBeInTheDocument();
    expect(screen.getByText("Connect your agent")).toBeInTheDocument();
    expect(screen.getByLabelText("Setup prompt")).toHaveValue(
      `Set up Open Artifacts for me: follow ${location.origin}/llms.txt`,
    );
    expect(screen.getByText("Waiting for your agent…")).toBeInTheDocument();
    expect(screen.getByText("Publish your first artifact")).toBeInTheDocument();
  });

  it("ticks the connection from a token, then the artifact", async () => {
    server.use(
      none(),
      http.get("*/api/v1/members", () =>
        HttpResponse.json(fixtures.members.filter((m) => m.role === "owner")),
      ),
    );
    mount("/");
    await heading();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Your agent is connected.")).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for the first artifact…"),
    ).toBeInTheDocument();
  });

  it("ticks the artifact from the server when the own one is past the loaded pages (#1832)", async () => {
    // Only someone else's artifact is loaded; the server knows the owner has one.
    const theirs = fixtures.artifacts[0];
    if (!theirs) throw new Error("no fixture");
    server.use(
      http.get("*/api/v1/artifacts", () =>
        page(
          [{ ...theirs, owner: { ...theirs.owner, id: "someone-else" } }],
          "next",
        ),
      ),
      ...noTokens(),
      http.get("*/api/v1/onboarding", () =>
        HttpResponse.json({
          dismissed: false,
          completed: false,
          hasArtifacts: true,
        }),
      ),
    );
    mount("/");
    await heading();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(
      screen.getByText("Your first artifact is in your Library."),
    ).toBeInTheDocument();
  });

  it("does not count the seeded Welcome as the first artifact (older server)", async () => {
    const W = "WmCnEfGhJk4mNpQr";
    const mine = {
      ...(fixtures.artifacts[0] as object),
      id: W,
      title: "Welcome",
    };
    server.use(
      http.get("*/api/v1/artifacts", () => page([mine], null)),
      ...noTokens(),
      http.get("*/api/v1/onboarding", () =>
        HttpResponse.json({ dismissed: false, completed: false, welcomeId: W }),
      ),
    );
    mount("/");
    await heading();
    expect(screen.getByText("Publish your first artifact")).toBeInTheDocument();
    expect(screen.getByText("0 of 3")).toBeInTheDocument();
  });

  it("an older server still counts an own artifact that is not the Welcome", async () => {
    const W = "WmCnEfGhJk4mNpQr";
    const welcome = {
      ...(fixtures.artifacts[0] as object),
      id: W,
      title: "Welcome",
    };
    server.use(
      http.get("*/api/v1/artifacts", () =>
        page([welcome, fixtures.artifacts[0]], null),
      ),
      ...noTokens(),
      http.get("*/api/v1/onboarding", () =>
        HttpResponse.json({ dismissed: false, completed: false, welcomeId: W }),
      ),
    );
    mount("/");
    await heading();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("uses only the server's answer when it gives one, even with own artifacts loaded", async () => {
    server.use(
      http.get("*/api/v1/artifacts", () => page([fixtures.artifacts[0]], null)),
      ...noTokens(),
      http.get("*/api/v1/onboarding", () =>
        HttpResponse.json({
          dismissed: false,
          completed: false,
          hasArtifacts: false,
          welcomeId: null,
        }),
      ),
    );
    mount("/");
    await heading();
    expect(screen.getByText("0 of 3")).toBeInTheDocument();
  });

  it("is not shown to invited members", async () => {
    mountHosted(
      "/",
      true,
      (m) => ({ ...m, user: { ...m.user, role: "member" } }),
      [none(), ...noTokens()],
    );
    await screen.findByText("No artifacts yet");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("ticks the invite once someone else is a member", async () => {
    server.use(none(), ...noTokens());
    server.use(
      http.get("*/api/v1/members", () => HttpResponse.json(fixtures.members)),
    );
    mount("/");
    await heading();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Invite people" })).toBeNull();
  });

  it("hides on Hide and stays hidden", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull(),
    );
    // The server holds it: a fresh mount (another browser) is still hidden.
    cleanup();
    mount("/");
    await screen.findByText("No artifacts yet");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
    expect(
      Object.keys(localStorage).filter((k) => k.includes("getStarted")),
    ).toEqual([]);
  });

  it("leaves on its own once all three steps are done", async () => {
    mount("/");
    await screen.findByRole("link", { name: fixtures.artifacts[0]?.title });
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("omits the trial line off Solo (self-hosted)", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    expect(screen.queryByText(trialLine)).toBeNull();
  });

  const hosted = (over: Record<string, unknown>) =>
    mountHosted("/", true, billing(over), [none(), ...noTokens()]);

  it("says the trial line on Solo and free when a trial can start", async () => {
    hosted({});
    await heading();
    expect(
      screen.getByText(
        "Inviting someone starts a 30-day Team trial. Your Solo plan stays as it is.",
      ),
    ).toBeInTheDocument();
  });

  it("says the trial line on the free tier", async () => {
    hosted({ tier: "free" });
    await heading();
    expect(screen.getByText(trialLine)).toBeInTheDocument();
    expect(screen.queryByText(/Solo plan/)).toBeNull();
  });

  it("marks the current step", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    const cur = document.querySelector('[aria-current="step"]');
    expect(cur).toHaveTextContent("Connect your agent");
    expect(cur).toHaveTextContent("(current step)");
  });

  it("omits the trial line once a trial was used", async () => {
    hosted({ trialEndsAt: "2026-01-01T00:00:00.000Z" });
    await heading();
    expect(screen.queryByText(trialLine)).toBeNull();
  });

  it("omits the trial line when paused or read-only", async () => {
    hosted({ readOnly: true, status: "lapsed", reason: "solo_unpaid" });
    await heading();
    expect(screen.queryByText(trialLine)).toBeNull();
  });

  it("offers Invite people and Not now only at step 3", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    expect(screen.queryByRole("link", { name: "Invite people" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("Not now hides the checklist once the first artifact exists", async () => {
    mount("/");
    // Default fixtures: a token and artifacts, but only the owner as member.
    server.use(
      http.get("*/api/v1/members", () =>
        HttpResponse.json(fixtures.members.filter((m) => m.role === "owner")),
      ),
    );
    await heading();
    expect(
      screen.getByRole("link", { name: "Invite people" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull(),
    );
  });

  it("shows to an owner whose agent connected before their first visit", async () => {
    // A token and an artifact by someone else already exist; the owner never
    // opened the Library. It is open, not decided away by first-visit timing.
    server.use(
      none(),
      http.get("*/api/v1/members", () =>
        HttpResponse.json(fixtures.members.filter((m) => m.role === "owner")),
      ),
    );
    mount("/");
    await heading();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Your agent is connected.")).toBeInTheDocument();
  });

  it("stays gone once finished, even when a step later undoes", async () => {
    let members = fixtures.members;
    server.use(http.get("*/api/v1/members", () => HttpResponse.json(members)));
    mount("/");
    await screen.findByRole("link", { name: fixtures.artifacts[0]?.title });
    // All three done: the completion is saved on the server.
    await waitFor(async () => {
      const r = await fetch("/api/v1/onboarding");
      expect(await r.json()).toMatchObject({ completed: true });
    });
    cleanup();
    members = fixtures.members.filter((m) => m.role === "owner");
    mount("/");
    await screen.findByRole("link", { name: fixtures.artifacts[0]?.title });
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("does not show once the server says it was hidden", async () => {
    server.use(
      none(),
      ...noTokens(),
      http.get("*/api/v1/onboarding", () =>
        HttpResponse.json({ dismissed: true, completed: false }),
      ),
    );
    mount("/");
    await screen.findByText("No artifacts yet");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("styles Invite people with the accent", async () => {
    mount("/");
    server.use(
      http.get("*/api/v1/members", () =>
        HttpResponse.json(fixtures.members.filter((m) => m.role === "owner")),
      ),
    );
    await heading();
    expect(
      screen.getByRole("link", { name: "Invite people" }).className,
    ).toMatch(/--oa-accent/);
  });

  it("re-reads Me and the members after an invite (the trial line and invite step)", async () => {
    server.use(
      http.post("*/api/v1/members", () =>
        HttpResponse.json(
          {
            ...fixtures.members.find((m) => m.role !== "owner"),
            emailed: false,
          },
          { status: 201 },
        ),
      ),
    );
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useInviteMember(), { wrapper: wrap });
    await act(() =>
      result.current.mutateAsync({ email: "new@example.com", role: "member" }),
    );
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(qk.me);
    expect(keys).toContainEqual(qk.members);
  });
});
