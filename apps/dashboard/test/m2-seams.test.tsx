// M2 whole-track review: cross-task seams.
import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { qk } from "../src/api/queries";
import { installHarness, lastClient, mount, server } from "./harness";

installHarness();

const NAME = fixtures.me.instance.name; // "Acme Artifacts"

describe("instance name", () => {
  it("is in document.title", async () => {
    mount("/settings/connections");
    await screen.findByRole("heading", { name: "Personal access tokens" });
    expect(document.title).toBe(`Connections · ${NAME}`);
  });
});

describe("role change mid-session", () => {
  it("a demoted admin leaves admin settings once an admin endpoint 404s", async () => {
    const router = mount("/settings/members");
    await screen.findByRole("combobox", { name: /^Role for / });
    // Another admin demotes this user; the server now answers admin routes with 404.
    server.use(
      http.get(`*${R.me}`, () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role: "member" },
        }),
      ),
      http.get(`*${R.members}`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    await lastClient.invalidateQueries({ queryKey: qk.members });
    await waitFor(
      () => expect(router.state.location.pathname).toBe("/settings/connections"),
      { timeout: 3000 },
    );
    expect(
      screen.queryByRole("link", { name: "Instance" }),
    ).not.toBeInTheDocument();
  });
});

describe("sign-in for visitors not signed in", () => {
  const anonymous = () =>
    server.use(
      http.get(`*${R.me}`, () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "Sign in" } },
          { status: 401 },
        ),
      ),
    );
  const setMeta = (content: string) => {
    const m = document.createElement("meta");
    m.name = "oa-instance";
    m.content = content;
    document.head.append(m);
    return () => m.remove();
  };

  it("names the instance from the shell's oa-instance meta", async () => {
    anonymous();
    const cleanup = setMeta("Globex <Docs>");
    try {
      mount("/sign-in");
      expect(
        await screen.findByText("Use your work email to open Globex <Docs>."),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(document.title).toBe("Sign in · Globex <Docs>"),
      );
    } finally {
      cleanup();
    }
  });

  it("falls back to Open Artifacts when the meta is absent or blank", async () => {
    anonymous();
    const cleanup = setMeta("   ");
    try {
      mount("/sign-in");
      expect(
        await screen.findByText("Use your work email to open Open Artifacts."),
      ).toBeInTheDocument();
    } finally {
      cleanup();
    }
  });
});
