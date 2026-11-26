import { R } from "@oa/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { installClock, settle } from "./clock";
import { installHarness, lastClient, mount, server } from "./harness";

installHarness();
installClock();

const usage = (metrics: { key: string; used: number; limit: number }[]) =>
  server.use(
    http.get(`*${R.usage}`, () =>
      HttpResponse.json({
        available: true,
        plan: "free",
        date: "2026-10-18",
        metrics,
      }),
    ),
  );
const meter = (name: string) => screen.findByRole("meter", { name });
const card = async (name: string) =>
  (await meter(name)).closest("section") as HTMLElement;
const nameInput = () =>
  screen.findByLabelText(/instance name/i) as Promise<HTMLInputElement>;

describe("usage review", () => {
  it("ignores unknown metric keys", async () => {
    usage([
      { key: "requests", used: 10, limit: 100 },
      { key: "r2_class_a", used: 1, limit: 1000 },
    ]);
    mount("/settings/usage");
    expect(await meter("Worker requests")).toBeTruthy();
  });

  it("over the limit is not labelled near limit", async () => {
    usage([{ key: "requests", used: 250, limit: 100 }]);
    mount("/settings/usage");
    const c = await card("Worker requests");
    expect(c.textContent).not.toMatch(/near limit/);
  });

  it("limit 0 (no daily cap) is never a calm 0% meter", async () => {
    usage([{ key: "requests", used: 5, limit: 0 }]);
    mount("/settings/usage");
    const c = await screen.findByRole("region", { name: "Worker requests" });
    expect(c.textContent).not.toMatch(/(^|\D)0%/);
    expect(screen.queryByRole("meter", { name: "Worker requests" })).toBeNull();
  });

  it("raises the near-limit banner", async () => {
    usage([{ key: "do_requests", used: 97, limit: 100 }]);
    mount("/settings/usage");
    await meter("Durable Object requests");
    expect(
      screen.getByText(/Durable Object requests are at 97% of today's limit/),
    ).toBeTruthy();
  });

  it("conveys the warning tone by text", async () => {
    usage([{ key: "requests", used: 85, limit: 100 }]);
    mount("/settings/usage");
    const m = await meter("Worker requests");
    const c = m.closest("section") as HTMLElement;
    expect(`${c.textContent} ${m.getAttribute("aria-valuetext")}`).toMatch(
      /warn|approach|high|limit/i,
    );
  });

  it("keeps aria-valuenow within aria-valuemax", async () => {
    usage([{ key: "requests", used: 250, limit: 100 }]);
    mount("/settings/usage");
    const m = await meter("Worker requests");
    expect(Number(m.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(
      Number(m.getAttribute("aria-valuemax")),
    );
  });

  it("negative used never shows more left than the limit", async () => {
    usage([{ key: "requests", used: -5, limit: 100 }]);
    mount("/settings/usage");
    const c = await card("Worker requests");
    expect(c.textContent).not.toMatch(/105 left/);
  });
});

describe("instance review", () => {
  it("typing during an in-flight save is not wiped", async () => {
    server.use(
      http.patch(`*${R.settings}`, async () => {
        await delay(150);
        return undefined; // fall through to the stateful mock
      }),
    );
    mount("/settings/instance");
    const input = await nameInput();
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    // While the save is in flight the box is locked, so nothing can be typed
    // into it and then lost; what was typed stays in it.
    await waitFor(() => expect(input).toBeDisabled());
    expect(input.value).toBe("First");
    await settle(150);
    // Once the save settles the box is open again, with what was saved.
    await waitFor(() => expect(input).toBeEnabled());
    expect(input.value).toBe("First");
  });

  it("an over-long name explains why Save is disabled", async () => {
    mount("/settings/instance");
    const input = await nameInput();
    fireEvent.change(input, { target: { value: "x".repeat(81) } });
    expect(
      (screen.getByRole("button", { name: /save/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByText(/80/)).toBeTruthy();
  });

  it("shows the saved name in the sidebar", async () => {
    mount("/settings/instance");
    const input = await nameInput();
    expect(screen.getByText(/Shown in the sidebar/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "Northwind Eng" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(
        screen.getAllByText("Northwind Eng").filter((e) => e !== input).length,
      ).toBeGreaterThan(0),
    );
  });

  it("a failed background refetch keeps the form and draft", async () => {
    mount("/settings/instance");
    const input = await nameInput();
    fireEvent.change(input, { target: { value: "Draft name" } });
    server.use(
      http.get(`*${R.settings}`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "x" } },
          { status: 404 },
        ),
      ),
    );
    await act(() => lastClient.refetchQueries({ queryKey: ["settings"] }));
    await waitFor(() =>
      expect(screen.queryByText(/Couldn't load instance/)).toBeNull(),
    );
    expect(
      (screen.queryByLabelText(/instance name/i) as HTMLInputElement | null)
        ?.value,
    ).toBe("Draft name");
  });
});
