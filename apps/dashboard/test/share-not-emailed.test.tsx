// #2590 / #2620: a saved
// share that sent no email says why, in OA Product's words. #2620 at
// f4a162b0 dropped outside_no_unsubscribe: an unknown reason fails the parse.
import { ShareResultSchema, viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen } from "@testing-library/react";
import { getResponse, HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ShareResultLocalSchema } from "../src/api/queries";
import {
  instanceLimitLine,
  LIMIT_LINE,
  memberLimitLine,
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
  it("member_limit", () => {
    expect(notEmailedLine("member_limit", "Acme")).toBe(
      "We didn't email them: you've reached today's limit of 20 new people outside Acme. Copy the link and send it yourself.",
    );
    expect(memberLimitLine("Acme")).toBe(
      notEmailedLine("member_limit", "Acme"),
    );
  });
  it("only #2620's reasons parse (outside_no_unsubscribe is gone)", () => {
    expect(ShareResultSchema.shape.notEmailed.unwrap().options).toEqual([
      "member_limit",
      "instance_limit",
      "limit",
    ]);
    const base = {
      email: "a@b.co",
      role: "viewer",
      createdAt: "x",
      emailed: false,
    };
    expect(
      ShareResultSchema.safeParse({
        ...base,
        notEmailed: "outside_no_unsubscribe",
      }).success,
    ).toBe(false);
    expect(
      ShareResultSchema.safeParse({
        ...base,
        notEmailed: "member_limit",
        limit: 20,
      }).success,
    ).toBe(true);
  });
  it("member_limit uses the server's limit, else 20", () => {
    expect(notEmailedLine("member_limit", "Acme", 5)).toBe(
      "We didn't email them: you've reached today's limit of 5 new people outside Acme. Copy the link and send it yourself.",
    );
    expect(notEmailedLine("member_limit", "Acme", undefined)).toContain(
      "today's limit of 20 new people",
    );
  });
  it("the generic limit: Product's neutral line", () => {
    expect(notEmailedLine("limit", "Acme")).toBe(
      "We didn't email them this time. Copy the link and send it yourself.",
    );
    expect(LIMIT_LINE).toBe(notEmailedLine("limit", "Acme"));
  });
  it("#2649 skipped: the neutral line, word for word, and never why", () => {
    expect(notEmailedLine("skipped", "Acme")).toBe(
      "We didn't email them this time. Copy the link and send it yourself.",
    );
    expect(notEmailedLine("skipped", "Acme", 20)).toBe(LIMIT_LINE);
  });
  it("#2649 skipped parses (PROVISIONAL, locally until @oa/shared has it)", () => {
    expect(
      ShareResultLocalSchema.safeParse({
        email: "a@b.co",
        role: "viewer",
        createdAt: "x",
        emailed: false,
        notEmailed: "skipped",
      }).success,
    ).toBe(true);
  });
  it("instance_limit", () => {
    const line =
      "We didn't email them: Acme has reached today's limit for new people outside. Copy the link and send it yourself.";
    expect(notEmailedLine("instance_limit", "Acme")).toBe(line);
    expect(instanceLimitLine("Acme")).toBe(line);
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
      "member_limit",
      /^We didn't email them: you've reached today's limit of 20 new people outside .+\. Copy the link and send it yourself\.$/,
    ],
    [
      "instance_limit",
      /^We didn't email them: .+ has reached today's limit for new people outside\. Copy the link and send it yourself\.$/,
    ],
    [
      "limit",
      /^We didn't email them this time\. Copy the link and send it yourself\.$/,
    ],
    [
      "skipped",
      /^We didn't email them this time\. Copy the link and send it yourself\.$/,
    ],
  ])("%s says so, and the link to copy stays", async (reason, line) => {
    await share(reason);
    const sent = document.querySelector("[data-share-sent]");
    expect(sent?.textContent).toMatch(line);
    expect(screen.getByLabelText("Artifact link")).toBeInTheDocument();
    // Amber: the notice is a warning for every reason.
    expect(
      document.querySelector("[data-share-sent]")?.closest("[data-tone]"),
    ).toHaveAttribute("data-tone", "warning");
  });
});
