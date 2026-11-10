// #1467: Settings › Notifications, the comment email switch.
import {
  COMMENT_EMAIL_HELP,
  COMMENT_EMAIL_HELP_NO_SENDER,
  type Me,
  R,
} from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { calls, installHarness, mount, server } from "./harness";

installHarness();

const withMe = (over: Partial<Me>, emailEnabled = true) => {
  let me: Me = {
    ...fixtures.me,
    ...over,
    instance: { ...fixtures.me.instance, emailEnabled },
  };
  server.use(
    http.get("*/api/v1/me", () => HttpResponse.json(me)),
    http.patch("*/api/v1/me", async ({ request }) => {
      const b = (await request.json()) as { commentEmail?: boolean };
      me = { ...me, commentEmail: b.commentEmail };
      return HttpResponse.json(me);
    }),
  );
};
const toggle = () =>
  screen.findByRole("switch", { name: "Email me about comments" });

describe("Settings › Notifications (#1467)", () => {
  it("is a Settings tab, on by default, with the help text", async () => {
    withMe({});
    mount("/settings/notifications");
    const s = await toggle();
    expect(s).toHaveAttribute("aria-checked", "true");
    expect(s).toBeEnabled();
    expect(screen.getByText(COMMENT_EMAIL_HELP)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notifications" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("turns comment emails off with PATCH /me and back on", async () => {
    withMe({ commentEmail: true });
    const patches = calls("PATCH");
    mount("/settings/notifications");
    const s = await toggle();
    fireEvent.click(s);
    await waitFor(() => expect(s).toHaveAttribute("aria-checked", "false"));
    await waitFor(() =>
      expect(patches.find((c) => c.path === R.me)?.body).toEqual({
        commentEmail: false,
      }),
    );
    await waitFor(() => expect(s).toBeEnabled());
    fireEvent.click(s);
    await waitFor(() => expect(s).toHaveAttribute("aria-checked", "true"));
  });

  it("shows off when turned off elsewhere (the unsubscribe link)", async () => {
    withMe({ commentEmail: false });
    mount("/settings/notifications");
    expect(await toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("is off and says why when the instance has no sender", async () => {
    withMe({ commentEmail: true }, false);
    mount("/settings/notifications");
    const s = await toggle();
    expect(s).toHaveAttribute("aria-checked", "false");
    expect(s).toBeDisabled();
    expect(screen.getByText(COMMENT_EMAIL_HELP_NO_SENDER)).toBeInTheDocument();
  });
});
