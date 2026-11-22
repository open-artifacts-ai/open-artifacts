import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { installHarness, mount, server } from "./harness";

installHarness();

const patches = () => {
  const out: unknown[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "PATCH" && request.url.endsWith(R.settings))
      out.push(await request.clone().json());
  });
  return out;
};
const nameInput = () =>
  screen.findByLabelText(/instance name/i) as Promise<HTMLInputElement>;

describe("instance settings", () => {
  it("loads name and default visibility", async () => {
    mount("/settings/instance");
    expect((await nameInput()).value).toBe(fixtures.me.instance.name);
    const radio = screen.getByRole("radio", {
      name: /restricted|anyone at/i,
      checked: true,
    });
    expect(radio.textContent).toMatch(
      fixtures.me.instance.defaultVisibility === "team"
        ? /^Anyone at /
        : /^Restricted$/,
    );
  });

  it("PATCH sends only changed fields", async () => {
    const sent = patches();
    mount("/settings/instance");
    const input = await nameInput();
    fireEvent.change(input, { target: { value: "  Acme Eng  " } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(sent).toEqual([{ name: "Acme Eng" }]));
  });

  it("sends visibility alone when only it changed", async () => {
    const sent = patches();
    mount("/settings/instance");
    await nameInput();
    const other =
      fixtures.me.instance.defaultVisibility === "team"
        ? "Restricted"
        : "Anyone at";
    fireEvent.click(
      screen.getByRole("radio", {
        name: other === "Restricted" ? other : /^Anyone at /,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(sent).toEqual([
        { defaultVisibility: other === "Restricted" ? "private" : "team" },
      ]),
    );
  });

  it("rejects an empty or over-long name without a request", async () => {
    const sent = patches();
    mount("/settings/instance");
    const input = await nameInput();
    fireEvent.change(input, { target: { value: "   " } });
    expect(
      (screen.getByRole("button", { name: /save/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(input, { target: { value: "x".repeat(81) } });
    expect(
      (screen.getByRole("button", { name: /save/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(sent).toEqual([]);
  });

  it("rolls back and toasts on failure", async () => {
    server.use(
      http.patch(`*${R.settings}`, () =>
        HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    mount("/settings/instance");
    const input = await nameInput();
    const before = input.value;
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(input.value).toBe(before));
  });

  it("untouched fields resync from the server after save", async () => {
    mount("/settings/instance");
    const input = await nameInput();
    fireEvent.change(input, { target: { value: "Renamed" } });
    // Server-side change to visibility while editing name.
    server.use(
      http.get(`*${R.settings}`, () =>
        HttpResponse.json({ name: "Renamed", defaultVisibility: "team" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("radio", { name: "Anyone at Renamed" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });
});
