// #2632 slice 2: the Setup column on Settings, Members (MemberSchema
// `setup`, #2639) and "Copy the setup line".
import { type Me, MemberSchema, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { shortDate } from "../src/api/memberSetup";
import { installClock, settle } from "./clock";
import { findVisibleToast, installHarness, mountHosted } from "./harness";

installHarness();
installClock();

const me = fixtures.me.user;
const ROWS = [
  {
    id: me.id,
    email: me.email,
    name: me.name,
    role: "owner",
    lastSeenAt: null,
    setup: { state: "set", done: 5 },
  },
  {
    id: "m_sam",
    email: "sam@example.com",
    name: "Sam Ortiz",
    role: "member",
    lastSeenAt: null,
    setup: { state: "partial", done: 3, stalled: "mention" },
  },
  {
    id: "m_priya",
    email: "priya@example.com",
    name: "Priya Shah",
    role: "member",
    lastSeenAt: null,
    setup: {
      state: "partial",
      done: 0,
      stalled: "agent",
      remindedAt: "2026-11-15T10:00:00.000Z",
    },
  },
  {
    id: "m_jon",
    email: "jon@example.com",
    name: "Jon Lee",
    role: "admin",
    lastSeenAt: null,
    setup: { state: "set", done: 5 },
  },
  {
    id: "m_chat",
    email: "chat@example.com",
    name: "Chet Chat",
    role: "member",
    lastSeenAt: null,
    // #2890: never connected the bus: of 3, never held up on named or mention.
    setup: { state: "partial", done: 2, total: 3, stalled: "ask" },
  },
  {
    id: "m_dana",
    email: "dana@example.com",
    name: null,
    role: "member",
    lastSeenAt: null,
    setup: { state: "invited", done: 0 },
  },
  {
    id: "m_ana",
    email: "ana@venue.example",
    name: null,
    role: "guest",
    lastSeenAt: null,
  },
];
const members = () =>
  http.get(`*${R.members}`, ({ request }) =>
    HttpResponse.json(
      new URL(request.url).searchParams.get("status") ? [] : ROWS,
    ),
  );
const as =
  (role: Me["user"]["role"]) =>
  (m: Me): Me => ({ ...m, user: { ...m.user, role } });
const row = async (who: string) =>
  (await screen.findByText(who)).closest("li") as HTMLElement;
const cell = (li: HTMLElement) =>
  li.querySelector("[data-setup]") as HTMLElement | null;

describe("the Setup column", () => {
  it("shows each state with the design's words", async () => {
    mountHosted("/settings/members", true, as("owner"), [members()]);
    const sam = cell(await row("Sam Ortiz"));
    expect(sam?.textContent).toBe("Setup: 3 of 5no agent reply yet");
    const priya = cell(await row("Priya Shah"));
    expect(priya?.textContent).toBe(
      "Setup: 0 of 5no agent connected yetReminded 15 Nov",
    );
    // #2890: the count of three, with the step that really holds it up.
    expect(cell(await row("Chet Chat"))?.textContent).toBe(
      "Setup: 2 of 3ask not answered yet",
    );
    expect(cell(await row("Jon Lee"))?.textContent).toBe("Setup: Set up");
    expect(cell(await row("dana@example.com"))?.textContent).toBe(
      "Setup: Invited",
    );
    expect(cell(await row("ana@venue.example"))?.textContent).toBe("Setup: –");
    // The owner's row carries setup too (the amended contract).
    expect(cell(await row("Ada Lovelace"))?.textContent).toBe("Setup: Set up");
  });

  it("counts of 6 and 4 with the comment step, held up on it (#2953)", async () => {
    const rows = http.get(`*${R.members}`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("status")
          ? []
          : [
              ROWS[0],
              {
                ...ROWS[1],
                setup: {
                  state: "partial",
                  done: 3,
                  total: 6,
                  stalled: "comment",
                },
              },
              {
                ...ROWS[2],
                setup: {
                  state: "partial",
                  done: 2,
                  total: 4,
                  stalled: "comment",
                },
              },
            ],
      ),
    );
    mountHosted("/settings/members", true, as("owner"), [rows]);
    expect(cell(await row("Sam Ortiz"))?.textContent).toBe(
      "Setup: 3 of 6no comment yet",
    );
    expect(cell(await row("Priya Shah"))?.textContent).toBe(
      "Setup: 2 of 4no comment yet",
    );
  });

  it("an admin sees it", async () => {
    mountHosted("/settings/members", true, as("admin"), [members()]);
    expect(cell(await row("Sam Ortiz"))).not.toBeNull();
  });

  it("a member doesn't see anyone's progress", async () => {
    mountHosted("/settings/members", true, as("member"), [members()]);
    await screen.findByRole("heading", { name: "Settings" });
    await settle(300);
    expect(document.querySelector("[data-setup]")).toBeNull();
    expect(document.body.textContent).not.toContain("no agent reply yet");
  });
});

describe("Copy the setup line", () => {
  const open = async (who: string) => {
    const btn = await screen.findByRole("button", { name: `More for ${who}` });
    fireEvent.pointerDown(btn, { button: 0, ctrlKey: false });
  };

  it("copies the line for someone not set up and says who to send it to", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    mountHosted("/settings/members", true, as("owner"), [members()]);
    await open("Sam Ortiz");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy the setup line" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `Set up Open Artifacts for me: follow ${location.origin}/llms.txt`,
      ),
    );
    await findVisibleToast("Copied. Send it to Sam.");
  });

  it("is on an invited row, not on a set-up one", async () => {
    mountHosted("/settings/members", true, as("owner"), [members()]);
    await open("dana@example.com");
    expect(
      await screen.findByRole("menuitem", { name: "Copy the setup line" }),
    ).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await open("Jon Lee");
    await screen.findByRole("menuitem", { name: "Remove…" });
    expect(
      screen.queryByRole("menuitem", { name: "Copy the setup line" }),
    ).toBeNull();
  });
});

describe("memberSetup (#2639's MemberSchema)", () => {
  it("parses a row with and without setup", () => {
    expect(MemberSchema.parse(ROWS[1]).setup?.stalled).toBe("mention");
    expect(
      MemberSchema.parse(ROWS.find((r) => r.role === "guest")).setup,
    ).toBeUndefined();
    expect(
      MemberSchema.parse(ROWS.find((r) => r.id === "m_chat")).setup?.total,
    ).toBe(3);
  });
  it("dates read as the screens do", () => {
    expect(shortDate("2026-11-15T10:00:00.000Z")).toBe("15 Nov");
    expect(shortDate("nope")).toBeNull();
  });
});
