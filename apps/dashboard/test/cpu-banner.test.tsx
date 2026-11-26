import { R, REPO_URL } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordCpuLimit } from "../src/api/client";
import { installClock } from "./clock";
import { installHarness, mount, server, wait } from "./harness";

installHarness();
installClock();

const TITLE = "Some requests hit Cloudflare's free CPU limit";
const DAY = "2026-10-19";

let served = 0;
const usage = (hits: number | null, date = DAY, plan?: "free" | "paid") => {
  served = 0;
  server.use(
    http.get(`*${R.usage}`, () => {
      served++;
      return HttpResponse.json({
        available: true,
        plan: plan ?? "free",
        date,
        metrics: [
          { key: "requests", used: 1200, limit: 100000 },
          ...(hits === null
            ? []
            : [{ key: "cpu_limit_hits", used: hits, limit: 0 }]),
        ],
      });
    }),
  );
};
const asRole = (role: "admin" | "member" | "guest") =>
  server.use(
    http.get(`*${R.me}`, () =>
      HttpResponse.json({
        ...fixtures.me,
        user: { ...fixtures.me.user, role },
      }),
    ),
  );
// me, then usage: two round trips before the banner can show.
const SLOW = { timeout: 5_000 };
const banner = () => screen.findByText(TITLE, {}, SLOW);
/** Waits for the library and the usage answer (owner), then asserts there is no banner. */
const noBanner = async () => {
  await screen.findByRole("heading", { name: "Library" });
  await waitFor(() => expect(served).toBeGreaterThan(0));
  await wait(30);
  expect(screen.queryByText(TITLE)).toBeNull();
};

describe("CPU banner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${DAY}T12:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  it("owner with 3+ hits today: count, plan link and Learn more", async () => {
    usage(4);
    mount("/");
    await banner();
    expect(
      screen.getByText(/Your instance hit the limit 4 times today/),
    ).toBeTruthy();
    expect(screen.getByText(/Workers Paid \(\$5 a month\)/)).toBeTruthy();
    const plans = screen.getByRole("link", { name: /See plans/ });
    expect(plans.getAttribute("href")).toBe(
      "https://dash.cloudflare.com/?to=/:account/workers/plans",
    );
    expect(plans.getAttribute("target")).toBe("_blank");
    expect(
      screen.getByRole("link", { name: /Learn more/ }).getAttribute("href"),
    ).toBe(
      "https://open-artifacts.com/docs/self-hosting-costs/#hitting-the-cpu-limit",
    );
    expect(screen.queryByText(/Ask your instance owner/)).toBeNull();
  });

  it("stays hidden under 3 hits, at 0 hits, and without the metric", async () => {
    for (const hits of [2, 0, null]) {
      usage(hits);
      mount("/");
      await noBanner();
      cleanup();
    }
  });

  it("ignores yesterday's count", async () => {
    usage(9, "2026-10-18");
    mount("/");
    await noBanner();
  });

  it("a 1102 shows it before any count, then the count takes over", async () => {
    usage(null);
    mount("/");
    await screen.findByRole("heading", { name: "Library" });
    act(() => recordCpuLimit());
    await banner();
    expect(
      screen.getByText(/A request just hit Cloudflare's free CPU limit\./),
    ).toBeTruthy();
  });

  it("with a recent 1102, one hit reads '1 time'", async () => {
    recordCpuLimit();
    usage(1);
    mount("/");
    expect(
      await screen.findByText(/hit the limit 1 time today/, {}, SLOW),
    ).toBeTruthy();
  });

  it("a 1102 older than a few minutes no longer counts", async () => {
    recordCpuLimit(Date.now() - 20 * 60_000);
    usage(0);
    mount("/");
    await noBanner();
  });

  it("members get the owner hint and no plan link", async () => {
    asRole("member");
    recordCpuLimit();
    mount("/");
    await banner();
    expect(screen.getByText(/Ask your instance owner about upgrading\./));
    expect(screen.queryByRole("link", { name: /See plans/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Learn more/ })).toBeTruthy();
  });

  it("admins get the plan link", async () => {
    asRole("admin");
    usage(3);
    mount("/");
    await banner();
    expect(screen.getByRole("link", { name: /See plans/ })).toBeTruthy();
  });

  it("dismissed for the rest of the UTC day, back the next day if hits remain", async () => {
    usage(5);
    mount("/");
    await banner();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    expect(localStorage.getItem("oa.cpuBanner.dismissed")).toBe(DAY);

    // Later the same day: still dismissed.
    cleanup();
    vi.setSystemTime(new Date(`${DAY}T23:59:00Z`));
    mount("/");
    await noBanner();

    // Next UTC day with hits again: back.
    cleanup();
    vi.setSystemTime(new Date("2026-10-20T00:01:00Z"));
    usage(3, "2026-10-20");
    mount("/");
    await banner();
  });

  it("dismissing after midnight stores the day of the click", async () => {
    vi.setSystemTime(new Date(`${DAY}T23:59:00Z`));
    usage(5);
    mount("/");
    await banner();
    vi.setSystemTime(new Date("2026-10-20T00:01:00Z")); // no re-render since
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(localStorage.getItem("oa.cpuBanner.dismissed")).toBe("2026-10-20");
  });

  it("the next day with no hits it stays gone", async () => {
    localStorage.setItem("oa.cpuBanner.dismissed", "2026-10-18");
    usage(0);
    mount("/");
    await noBanner();
  });

  describe("on Workers Paid (#279)", () => {
    const PAID_TITLE = "Some requests hit Cloudflare's CPU limit";
    /** The plan comes from Me, for every role. */
    const paidMe = (role: "owner" | "admin" | "member" = "owner") =>
      server.use(
        http.get(`*${R.me}`, () =>
          HttpResponse.json({
            ...fixtures.me,
            user: { ...fixtures.me.user, role },
            instance: { ...fixtures.me.instance, plan: "paid" },
          }),
        ),
      );

    it("reports the 30-second limit and never pitches an upgrade", async () => {
      paidMe();
      usage(4, DAY, "paid");
      mount("/");
      await screen.findByText(PAID_TITLE, {}, SLOW);
      expect(screen.queryByText(TITLE)).toBeNull();
      expect(
        screen.getByText(
          "Your instance hit the 30-second per-request limit 4 times today. Retrying usually works. If it keeps happening, please report it so we can fix it.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "View usage" }).getAttribute("href"),
      ).toBe("/settings/usage");
      const report = screen.getByRole("link", { name: /Report an issue/ });
      expect(report.getAttribute("href")).toBe(`${REPO_URL}/issues/new`);
      expect(report.getAttribute("target")).toBe("_blank");
      expect(document.body.textContent).not.toMatch(/Workers Paid|See plans/);
    });

    it("a 1102 before any count has no number", async () => {
      paidMe();
      usage(0, DAY, "paid");
      recordCpuLimit();
      mount("/");
      expect(
        await screen.findByText(
          "Your instance hit the 30-second per-request limit today. Retrying usually works. If it keeps happening, please report it so we can fix it.",
          {},
          SLOW,
        ),
      ).toBeTruthy();
    });

    it("members get the Paid copy too, without View usage", async () => {
      paidMe("member");
      recordCpuLimit();
      mount("/");
      await screen.findByText(PAID_TITLE, {}, SLOW);
      expect(screen.queryByRole("link", { name: "View usage" })).toBeNull();
      expect(
        screen.getByRole("link", { name: /Report an issue/ }),
      ).toBeTruthy();
      expect(document.body.textContent).not.toMatch(
        /Workers Paid|See plans|instance owner/,
      );
    });

    it("stays hidden under 3 hits and dismisses like the Free banner", async () => {
      paidMe();
      usage(2, DAY, "paid");
      mount("/");
      await noBanner();
      expect(screen.queryByText(PAID_TITLE)).toBeNull();
      cleanup();
      usage(3, DAY, "paid");
      mount("/");
      await screen.findByText(PAID_TITLE, {}, SLOW);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      await waitFor(() => expect(screen.queryByText(PAID_TITLE)).toBeNull());
      expect(localStorage.getItem("oa.cpuBanner.dismissed")).toBe(DAY);
    });
  });
});
