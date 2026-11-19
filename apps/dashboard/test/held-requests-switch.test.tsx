// #2577: "Held requests" in Settings → Connections: send held requests to my phone.
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calls,
  events,
  findVisibleToast,
  installHarness,
  mount,
  server,
} from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();
afterEach(() => vi.unstubAllGlobals());

const KEY = http.get(`*${R.mePushKey}`, () =>
  HttpResponse.json({
    publicKey:
      "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
  }),
);
const NO_KEY = http.get(`*${R.mePushKey}`, () =>
  HttpResponse.json(
    { error: { code: "push_unavailable", message: "x" } },
    { status: 404 },
  ),
);
/** A browser that can do push, with this permission. */
const browser = (perm: NotificationPermission) => {
  vi.stubGlobal("Notification", { permission: perm });
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      addEventListener() {},
      removeEventListener() {},
      getRegistration: async () => undefined,
      ready: new Promise(() => {}),
    },
    configurable: true,
  });
};
const open = async (...first: Parameters<typeof server.use>) => {
  server.use(...first, ...createHandlers({ events, agentAsks: true }));
  mount("/settings/connections");
  return screen.findByRole(
    "switch",
    { name: "Send held requests to my phone" },
    { timeout: FIRST_LOAD_MS },
  );
};

describe("Held requests", () => {
  it("starts Off with the design's line, and saves the switch with { phonePush }", async () => {
    browser("granted");
    const puts = calls("PUT");
    const sw = await open(KEY);
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText("Off: they wait in your inbox."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Held requests" }),
    ).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() =>
      expect(puts.find((c) => c.path === R.agentRequests)?.body).toEqual({
        phonePush: true,
      }),
    );
    expect(
      await screen.findByText(
        /^On: a held request also sends a notification to your phone\./,
      ),
    ).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("a refused save puts it back and says so", async () => {
    browser("granted");
    const sw = await open(
      KEY,
      http.put(`*${R.agentRequests}`, () =>
        HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    await waitFor(() => expect(sw).toBeEnabled());
    fireEvent.click(sw);
    await findVisibleToast(/./);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
  });

  it("with no push key on the server it says so and links to Settings, Notifications", async () => {
    browser("granted");
    const sw = await open(NO_KEY);
    await waitFor(() => expect(sw).toBeEnabled());
    const line = await waitFor(() => {
      const el = document.querySelector("[data-held-blocked]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(line).toHaveTextContent("Browser notifications aren't set up for");
    expect(line.querySelector("a")).toHaveAttribute(
      "href",
      "/settings/notifications",
    );
  });

  it("with notifications blocked in this browser it says so", async () => {
    browser("denied");
    await open(KEY);
    expect(
      await screen.findByText(
        /Your browser is blocking notifications from this site\./,
      ),
    ).toBeInTheDocument();
  });

  it("with notifications set up, no warning line", async () => {
    browser("granted");
    const sw = await open(KEY);
    await waitFor(() => expect(sw).toBeEnabled());
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector("[data-held-blocked]")).toBeNull();
  });

  it("history rows from the server say 'on your list'", async () => {
    browser("granted");
    await open(KEY);
    await screen.findByRole("heading", { name: "Who asked what" });
    await waitFor(() =>
      expect(document.body.textContent).toContain("yesterday · on your list"),
    );
  });
});
