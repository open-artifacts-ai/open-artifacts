// #2590 / #2620 (PROVISIONAL until #2620 lands in packages/shared): a saved
// share that sent no email says why, in OA Product's words.
import { viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen } from "@testing-library/react";
import { getResponse, HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
  instanceLimitLine,
  memberLimitLine,
  NO_EMAIL_LINE,
  notEmailedLine,
} from "../src/viewer/panels/shareRoles";
import { installHarness, mountHosted } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const panel = `${viewerPath(OWNED)}?panel=open&tab=share`;

describe("the lines (OA Product, #2620)", () => {
  it("outside_no_unsubscribe: the existing no-email line", () => {
    expect(notEmailedLine("outside_no_unsubscribe", "Acme")).toBe(
      "We won't email them about this share. Copy the link and send it yourself.",
    );
    expect(NO_EMAIL_LINE).toBe(
      "We won't email them about this share. Copy the link and send it yourself.",
    );
  });
  it("member_limit", () => {
    expect(notEmailedLine("member_limit", "Acme")).toBe(
      "We didn't email them: you've reached today's limit of 20 new people outside Acme. Copy the link and send it yourself.",
    );
    expect(memberLimitLine("Acme")).toBe(
      notEmailedLine("member_limit", "Acme"),
    );
  });
  it("member_limit uses the server's limit, else 20", () => {
    expect(notEmailedLine("member_limit", "Acme", 5)).toBe(
      "We didn't email them: you've reached today's limit of 5 new people outside Acme. Copy the link and send it yourself.",
    );
    expect(notEmailedLine("member_limit", "Acme", undefined)).toContain(
      "today's limit of 20 new people",
    );
  });
  it("instance_limit (and the generic limit)", () => {
    const line =
      "We didn't email them: Acme has reached today's limit for new people outside. Copy the link and send it yourself.";
    expect(notEmailedLine("instance_limit", "Acme")).toBe(line);
    expect(instanceLimitLine("Acme")).toBe(line);
    expect(notEmailedLine("limit", "Acme")).toBe(line);
  });
});

describe("in the Share panel, after saving", () => {
  const share = async (reason: string) => {
    const base = createHandlers({ hosted: true });
    mountHosted(panel, true, undefined, [
      http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
        const res = await getResponse(base, request);
        if (!res?.ok) return res;
        const body = (await res.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ...body,
          emailed: false,
          notEmailed: reason,
        });
      }),
    ]);
    const box = await screen.findByLabelText("Email");
    fireEvent.change(box, { target: { value: "sam@partner.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    return screen.findByText(/Shared with sam@partner\.org/);
  };

  it("the panel names the server's member limit", async () => {
    const base = createHandlers({ hosted: true });
    mountHosted(panel, true, undefined, [
      http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
        const res = await getResponse(base, request);
        if (!res?.ok) return res;
        const body = (await res.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ...body,
          emailed: false,
          notEmailed: "member_limit",
          limit: 7,
        });
      }),
    ]);
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "sam@partner.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText(/Shared with sam@partner\.org/);
    expect(document.querySelector("[data-share-sent]")?.textContent).toMatch(
      /^We didn't email them: you've reached today's limit of 7 new people outside .+\. Copy the link and send it yourself\.$/,
    );
  });

  it.each([
    [
      "outside_no_unsubscribe",
      "We won't email them about this share. Copy the link and send it yourself.",
    ],
    [
      "member_limit",
      /^We didn't email them: you've reached today's limit of 20 new people outside .+\. Copy the link and send it yourself\.$/,
    ],
    [
      "instance_limit",
      /^We didn't email them: .+ has reached today's limit for new people outside\. Copy the link and send it yourself\.$/,
    ],
  ])("%s says so, and the link to copy stays", async (reason, line) => {
    await share(reason);
    const sent = document.querySelector("[data-share-sent]");
    expect(sent?.textContent).toMatch(
      typeof line === "string"
        ? new RegExp(`^${line.replace(/[.?]/g, "\\$&")}$`)
        : line,
    );
    expect(screen.getByLabelText("Artifact link")).toBeInTheDocument();
    // Amber: the notice is a warning for every reason.
    expect(
      document.querySelector("[data-share-sent]")?.closest("[data-tone]"),
    ).toHaveAttribute("data-tone", "warning");
  });
});
