// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  badgeVariants,
  buttonVariants,
  SidebarBrand,
  SidebarProvider,
} from "../src/shadcn";
import { tokens } from "../src/tokens/index";
import { cases } from "./shadcn-fixtures";

// jsdom has no ResizeObserver; Radix's popper (open tooltip) needs one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

// Structure only: jsdom can't compute color contrast. Contrast, focus outlines
// and both themes are checked in a real browser: test-browser/.
describe("shadcn core a11y (structure)", () => {
  for (const [name, el] of Object.entries(cases)) {
    it(`${name} has no axe violations`, async () => {
      render(<main>{el}</main>);
      // Portals (tooltip) land outside <main>; that's the app shell's concern.
      const result = await axe.run(document.body, {
        rules: { region: { enabled: false } },
      });
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });
  }
});

// WCAG contrast of 6-digit hex colors, with alpha blending for `/90`.
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)
  );
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
};
const over = (fg: number[], bg: number[], alpha: number) =>
  fg.map((v, i) => alpha * v + (1 - alpha) * (bg[i] as number));

describe("destructive variants", () => {
  const theme = readFileSync(
    `${import.meta.dirname}/../src/shadcn/theme.css`,
    "utf8",
  );
  const fgToken = /--destructive-foreground:\s*var\(--oa-([\w-]+)\)/.exec(
    theme,
  )?.[1] as string;

  it("use destructive-foreground on a full destructive fill", () => {
    for (const el of [
      <Button key="b" variant="destructive">
        x
      </Button>,
      <Badge key="g" variant="destructive">
        x
      </Badge>,
    ]) {
      const { container } = render(el);
      const cls = (container.firstElementChild as Element).className;
      expect(cls).toContain("text-destructive-foreground");
      expect(cls).not.toContain("text-white");
      expect(cls).not.toContain("dark:bg-destructive/");
      cleanup();
    }
  });

  it.each(["light", "dark"] as const)(
    "text is >= 4.5:1, also at the /90 hover (%s)",
    (t) => {
      const fg = rgb(tokens[fgToken]?.[t] as string);
      const danger = rgb(tokens.danger?.[t] as string);
      expect(contrast(fg, danger)).toBeGreaterThanOrEqual(4.5);
      for (const page of ["bg", "surface"]) {
        const hover = over(danger, rgb(tokens[page]?.[t] as string), 0.9);
        expect(contrast(fg, hover), `hover on ${page}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );
});

describe("Button", () => {
  it("default variant is primary (ink) and focus uses ring", () => {
    const cls = buttonVariants();
    expect(cls).toContain("bg-primary");
    expect(cls).toContain("text-primary-foreground");
    const classes = cls.split(/\s+/);
    expect(classes).toContain("focus-visible:outline-ring");
    expect(classes).toContain("focus-visible:outline-2");
    const theme = readFileSync(
      `${import.meta.dirname}/../src/shadcn/theme.css`,
      "utf8",
    );
    expect(theme).toMatch(/--primary:\s*var\(--oa-text\)/);
    expect(theme).toMatch(/--ring:\s*var\(--oa-focus\)/);
    expect(tokens.focus?.light).toBe("#2350D0");
  });
});

// Token math for every variant's edges: borders and focus outlines need 3:1
// on bg and surface (WCAG 1.4.11), the placeholder 4.5:1 (Input is transparent).
describe("variant edges", () => {
  const source = (name: string) =>
    readFileSync(`${import.meta.dirname}/../src/shadcn/ui/${name}.tsx`, "utf8");
  const pages = ["bg", "surface"];
  const ratio = (fg: string, bg: string, t: "light" | "dark") =>
    contrast(rgb(tokens[fg]?.[t] as string), rgb(tokens[bg]?.[t] as string));

  it.each([
    "button",
    "badge",
    "input",
    "select",
    "tabs",
    "toggle",
    "dialog",
    "scroll-area",
    "dropdown-menu",
    "popover",
    "sidebar",
    "sheet",
  ])("%s: focus is a solid ring outline, no translucent rings", (name) => {
    const src = source(name);
    expect(src).toMatch(/focus-visible:outline-(sidebar-)?ring(?![\w/-])/);
    // outline-none sets --tw-outline-style: none, so the style is explicit.
    expect(src).toContain("focus-visible:outline-solid");
    expect(src).not.toMatch(/focus-visible:ring-(ring|destructive)\//);
  });

  // Every class string that animates or slides opts out under reduced motion.
  it.each(
    readdirSync(`${import.meta.dirname}/../src/shadcn/ui`).map((f) =>
      f.replace(/\.tsx$/, ""),
    ),
  )("%s: motion respects prefers-reduced-motion", (name) => {
    const strings = source(name).match(/"[^"\n]*"/g) ?? [];
    const moving = (re: RegExp, opt: string) =>
      strings.filter((c) => re.test(c) && !c.includes(opt));
    expect(
      moving(
        /(?<![\w-])animate-(in|out)(?![\w-])/,
        "motion-reduce:animate-none!",
      ),
    ).toEqual([]);
    expect(
      moving(
        /transition-\[[^\]]*(width|left|margin|height)|transition-(all|transform)|(?<![\w-])transition(?![\w-])/,
        "motion-reduce:transition-none",
      ),
    ).toEqual([]);
  });

  it("outlined variants use border-input, not border-border", () => {
    const outline = (cls: string) =>
      cls.split(/\s+/).filter((c) => /^border-[a-z]/.test(c));
    expect(outline(buttonVariants({ variant: "outline" }))).toEqual([
      "border-input",
    ]);
    expect(outline(badgeVariants({ variant: "outline" }))).toContain(
      "border-input",
    );
    expect(source("input")).toContain("border-input");
    expect(source("input")).not.toContain("dark:bg-input");
  });

  it("--input maps to --oa-border-strong", () => {
    const theme = readFileSync(
      `${import.meta.dirname}/../src/shadcn/theme.css`,
      "utf8",
    );
    expect(theme).toMatch(/--input:\s*var\(--oa-border-strong\);/);
  });

  it.each(["light", "dark"] as const)("ratios hold (%s)", (t) => {
    for (const bg of pages) {
      // --input = --oa-border-strong, --ring = --oa-focus
      expect(
        ratio("border-strong", bg, t),
        `border on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
      expect(ratio("focus", bg, t), `focus on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(
        ratio("text-muted", bg, t),
        `placeholder on ${bg}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("SidebarBrand", () => {
  it("links home with the product name; the mark is decorative", () => {
    // SidebarProvider's useIsMobile needs matchMedia, which jsdom lacks.
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const { getByRole, container } = render(
      <SidebarProvider>
        <SidebarBrand href="/library" />
      </SidebarProvider>,
    );
    const link = getByRole("link", { name: "Open Artifacts" });
    expect(link.getAttribute("href")).toBe("/library");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    vi.unstubAllGlobals();
  });
});
