import {
  docSchema,
  docToMarkdown,
  markdownToDoc,
  yXmlFragmentToDoc,
} from "@oa/doc-schema";
import { TooltipProvider } from "@oa/ui/shadcn";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Editor, getSchema } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Toaster, toast } from "../src/layout/toast";
import { CaretActivity, FLAG_MS, renderCaret } from "../src/viewer/doc/cursors";
import { DocEditor, DocState, STATUS_TEXT } from "../src/viewer/doc/DocEditor";
import { isDocArtifact, setMockDoc } from "../src/viewer/doc/docMock";
import {
  contentExtensions,
  LINK_REFUSED,
  toAllowedHref,
} from "../src/viewer/doc/extensions";
import { isFresh, markFresh, NEW_DOC_TOAST } from "../src/viewer/doc/fresh";
import { TITLE_SAVE_MS, TitleField } from "../src/viewer/doc/TitleField";
import {
  ariaShortcut,
  hasMoreToTheRight,
  shortcutText,
  Toolbar,
} from "../src/viewer/doc/Toolbar";
import { type FakeProvider, fakeProviders } from "./doc-fake-provider";

type FakeLike = Pick<FakeProvider, "frame" | "close">;

// Radix's tooltip measures its arrow; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no layout: ProseMirror's focus scroll asks ranges for rects.
const noRects = () => Object.assign([], { item: () => null });
Range.prototype.getClientRects ??= noRects as never;
Range.prototype.getBoundingClientRect ??= (() =>
  new DOMRect(0, 0, 0, 0)) as never;

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

/** An editor on a Y.Doc, as the viewer builds it (minus cursors). */
function collab(content = "<p>hello world</p>") {
  const ydoc = new Y.Doc();
  const editor = new Editor({
    extensions: [
      ...contentExtensions(),
      Collaboration.configure({ document: ydoc, field: "default" }),
    ],
  });
  editors.push(editor);
  editor.commands.setContent(content);
  return { ydoc, editor };
}
const linkHrefs = (ydoc: Y.Doc) => {
  const found: string[] = [];
  const walk = (n: {
    marks?: { type: string; attrs?: { href?: string } }[];
    content?: unknown[];
  }) => {
    for (const m of n.marks ?? [])
      if (m.type === "link") found.push(m.attrs?.href ?? "");
    for (const c of n.content ?? []) walk(c as never);
  };
  walk(yXmlFragmentToDoc(ydoc.getXmlFragment("default")).toJSON());
  return found;
};

describe("schema", () => {
  it("the editor's schema is docSchema: same nodes, marks, content and attrs", () => {
    const ours = getSchema(contentExtensions());
    expect(Object.keys(ours.nodes).sort()).toEqual(
      Object.keys(docSchema.nodes).sort(),
    );
    expect(Object.keys(ours.marks).sort()).toEqual(
      Object.keys(docSchema.marks).sort(),
    );
    for (const [name, type] of Object.entries(docSchema.nodes)) {
      const mine = ours.nodes[name];
      expect(mine.spec.content, name).toBe(type.spec.content);
      for (const attr of Object.keys(type.spec.attrs ?? {}))
        expect(Object.keys(mine.spec.attrs ?? {}), `${name}.${attr}`).toContain(
          attr,
        );
    }
    // Links carry exactly href and title; Tiptap's target, rel and class stay out.
    expect(Object.keys(ours.marks.link.spec.attrs ?? {}).sort()).toEqual([
      "href",
      "title",
    ]);
    expect(ours.nodes.heading.spec.content).toBe("text*");
    expect(ours.marks.code.excludes(ours.marks.link)).toBe(false);
    // No Tiptap-only nodes or marks sneak in (underline).
    expect(ours.nodes.hardBreak).toBeDefined();
    expect(ours.marks.underline).toBeUndefined();
  });
});

describe("toolbar", () => {
  function setup() {
    const { editor } = collab("<p>hello world</p>");
    render(
      <TooltipProvider>
        <Toolbar editor={editor} />
      </TooltipProvider>,
    );
    // The first paragraph's text (the Y.Doc keeps a trailing empty paragraph).
    editor.commands.setTextSelection({ from: 1, to: 6 });
    return editor;
  }
  const click = (name: string) => {
    act(() => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  };

  it("has labelled icon buttons for the v1 set and nothing else", () => {
    setup();
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bold",
      "Italic",
      "Link",
      "Bulleted list",
      "Numbered list",
      "Task list",
      "Inline code",
      "Code block",
    ]);
  });

  it("puts a thin divider before the code buttons, after the lists", () => {
    setup();
    const bar = screen.getByRole("toolbar");
    const seps = [...bar.querySelectorAll(".oa-doc-sep")];
    expect(seps).toHaveLength(2);
    expect(seps[1].nextElementSibling).toHaveAttribute("data-tool", "code");
    expect(seps[1].previousElementSibling).toHaveAttribute("data-tool", "task");
    expect(seps[1]).toHaveAttribute("aria-hidden", "true");
  });

  it("hasMoreToTheRight: only when it overflows and is not at the end", () => {
    const at = (scrollWidth: number, clientWidth: number, scrollLeft: number) =>
      hasMoreToTheRight({ scrollWidth, clientWidth, scrollLeft });
    expect(at(390, 390, 0)).toBe(false); // fits
    expect(at(391, 390, 0)).toBe(false); // sub-pixel
    expect(at(450, 390, 0)).toBe(true); // cut at the right
    expect(at(450, 390, 30)).toBe(true); // scrolled a little
    expect(at(450, 390, 60)).toBe(false); // at the end
  });

  it("shows the fade (data-more) only while buttons are hidden to the right", () => {
    setup();
    const bar = screen.getByRole("toolbar");
    const dims = (scrollWidth: number, clientWidth: number, left: number) => {
      Object.defineProperty(bar, "scrollWidth", {
        value: scrollWidth,
        configurable: true,
      });
      Object.defineProperty(bar, "clientWidth", {
        value: clientWidth,
        configurable: true,
      });
      bar.scrollLeft = left;
      act(() => {
        bar.dispatchEvent(new Event("scroll"));
      });
    };
    // jsdom has no layout: it fits, so no fade.
    expect(bar).not.toHaveAttribute("data-more");
    dims(450, 390, 0);
    expect(bar).toHaveAttribute("data-more");
    dims(450, 390, 60);
    expect(bar).not.toHaveAttribute("data-more");
    dims(450, 390, 10);
    expect(bar).toHaveAttribute("data-more");
    expect(bar.querySelector(".oa-doc-fade")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("follows the on-screen keyboard: --oa-kb lifts the bar and data-keyboard drops the inset", () => {
    const vv = Object.assign(new EventTarget(), {
      height: window.innerHeight,
      offsetTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", {
      value: vv,
      configurable: true,
    });
    try {
      setup();
      const bar = screen.getByRole("toolbar");
      const root = document.documentElement;
      expect(bar).not.toHaveAttribute("data-keyboard");
      expect(root.style.getPropertyValue("--oa-kb")).toBe("0px");
      // The keyboard opens: the visual viewport loses 300 px.
      act(() => {
        vv.height = window.innerHeight - 300;
        vv.dispatchEvent(new Event("resize"));
      });
      expect(bar).toHaveAttribute("data-keyboard");
      expect(root.style.getPropertyValue("--oa-kb")).toBe("300px");
      // Browser chrome (tens of px) is not a keyboard.
      act(() => {
        vv.height = window.innerHeight - 60;
        vv.dispatchEvent(new Event("resize"));
      });
      expect(bar).not.toHaveAttribute("data-keyboard");
    } finally {
      Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("stops tracking the viewport when the bar goes away", () => {
    const vv = Object.assign(new EventTarget(), {
      height: window.innerHeight - 300,
      offsetTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", {
      value: vv,
      configurable: true,
    });
    try {
      const { unmount } = render(
        <TooltipProvider>
          <Toolbar editor={collab().editor} />
        </TooltipProvider>,
      );
      expect(document.documentElement.style.getPropertyValue("--oa-kb")).toBe(
        "300px",
      );
      unmount();
      expect(document.documentElement.style.getPropertyValue("--oa-kb")).toBe(
        "",
      );
    } finally {
      Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("names every button's shortcut: in a tooltip and in aria-keyshortcuts", async () => {
    setup();
    const want: Record<string, [string, string]> = {
      "Heading 1": ["Ctrl+Alt+1", "Control+Alt+1"],
      "Heading 2": ["Ctrl+Alt+2", "Control+Alt+2"],
      "Heading 3": ["Ctrl+Alt+3", "Control+Alt+3"],
      Bold: ["Ctrl+B", "Control+B"],
      Italic: ["Ctrl+I", "Control+I"],
      Link: ["Ctrl+K", "Control+K"],
      "Bulleted list": ["Ctrl+Shift+8", "Control+Shift+8"],
      "Numbered list": ["Ctrl+Shift+7", "Control+Shift+7"],
      "Task list": ["Ctrl+Shift+9", "Control+Shift+9"],
      "Inline code": ["Ctrl+E", "Control+E"],
      "Code block": ["Ctrl+Alt+C", "Control+Alt+C"],
    };
    for (const [name, [text, aria]] of Object.entries(want)) {
      const button = screen.getByRole("button", { name });
      expect(button, name).toHaveAttribute("aria-keyshortcuts", aria);
      act(() => {
        fireEvent.focus(button);
      });
      const tip = await screen.findByRole("tooltip");
      expect(tip.textContent, name).toBe(`${name} ${text}`);
      // Opens below the button, not over the title bar.
      expect(
        document.querySelector('[data-slot="tooltip-content"]'),
        name,
      ).toHaveAttribute("data-side", "bottom");
      act(() => {
        fireEvent.blur(button);
      });
    }
  });

  it("shows the Mac glyphs on a Mac and Ctrl names elsewhere", () => {
    const h1 = { mod: true, alt: true, key: "1" } as const;
    expect(shortcutText(h1, true)).toBe("⌘⌥1");
    expect(shortcutText(h1, false)).toBe("Ctrl+Alt+1");
    expect(shortcutText({ mod: true, key: "b" }, true)).toBe("⌘B");
    expect(shortcutText({ mod: true, shift: true, key: "8" }, true)).toBe(
      "⌘⇧8",
    );
    expect(ariaShortcut(h1, true)).toBe("Meta+Alt+1");
  });

  it("each shown shortcut is the one Tiptap binds", () => {
    const { editor } = collab("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const press = (key: string, code: number, mods: object) =>
      editor.view.someProp("handleKeyDown", (f) =>
        f(
          editor.view,
          new KeyboardEvent("keydown", {
            key,
            keyCode: code,
            ctrlKey: true,
            ...mods,
          }),
        ),
      );
    press("b", 66, {});
    expect(editor.isActive("bold")).toBe(true);
    press("i", 73, {});
    expect(editor.isActive("italic")).toBe(true);
    press("e", 69, {});
    expect(editor.isActive("code")).toBe(true);
    press("2", 50, { altKey: true });
    expect(editor.isActive("heading", { level: 2 })).toBe(true);
    press("2", 50, { altKey: true });
    press("8", 56, { shiftKey: true });
    expect(editor.isActive("bulletList")).toBe(true);
    press("8", 56, { shiftKey: true });
    press("7", 55, { shiftKey: true });
    expect(editor.isActive("orderedList")).toBe(true);
    press("7", 55, { shiftKey: true });
    press("9", 57, { shiftKey: true });
    expect(editor.isActive("taskList")).toBe(true);
    press("9", 57, { shiftKey: true });
    press("c", 67, { altKey: true });
    expect(editor.isActive("codeBlock")).toBe(true);
  });

  const shiftEnter = (editor: Editor) =>
    editor.view.someProp("handleKeyDown", (f) =>
      f(
        editor.view,
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          shiftKey: true,
        }),
      ),
    );

  it("Shift+Enter in a paragraph inserts a hardBreak that survives Markdown", () => {
    const { ydoc, editor } = collab("<p>onetwo</p>");
    editor.commands.setTextSelection(4);
    shiftEnter(editor);
    const doc = yXmlFragmentToDoc(ydoc.getXmlFragment("default"));
    expect(JSON.stringify(doc.toJSON())).toContain("hardBreak");
    const md = docToMarkdown(doc);
    expect(md.split("\n")[0]).toMatch(/^one\\?$|^one {2}$/);
    expect(md).toContain("two");
    const back = markdownToDoc(md).doc;
    expect(back.toJSON()).toEqual(doc.toJSON());
  });

  it("Shift+Enter and Mod+Enter in a code block add a newline and stay in the block", () => {
    for (const mod of [{ shiftKey: true }, { ctrlKey: true }]) {
      const { editor } = collab("<pre><code>one</code></pre>");
      editor.commands.setTextSelection(4);
      editor.view.someProp("handleKeyDown", (f) =>
        f(
          editor.view,
          new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, ...mod }),
        ),
      );
      expect(editor.state.doc.firstChild?.type.name, JSON.stringify(mod)).toBe(
        "codeBlock",
      );
      expect(editor.state.doc.firstChild?.textContent).toBe("one\n");
      expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    }
  });

  it("Shift+Enter in a heading puts no hardBreak in it", () => {
    const { editor } = collab("<h2>Title</h2>");
    editor.commands.setTextSelection(3);
    shiftEnter(editor);
    expect(JSON.stringify(editor.getJSON())).not.toContain("hardBreak");
    expect(editor.state.doc.firstChild?.textContent).toBe("Title");
  });

  it("Mod-K in the editor opens the link popover", async () => {
    const editor = setup();
    act(() => {
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(await screen.findByLabelText("Link URL")).toBeVisible();
  });

  it("shows the formats at the caret as pressed, and follows the selection", () => {
    const { editor } = collab(
      "<h2>Title</h2><p>plain <strong>bold</strong> text</p>",
    );
    render(
      <TooltipProvider>
        <Toolbar editor={editor} />
      </TooltipProvider>,
    );
    const pressed = () =>
      screen
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.getAttribute("aria-label"));
    act(() => {
      editor.commands.setTextSelection(3);
    });
    expect(pressed()).toEqual(["Heading 2"]);
    // Inside "bold" (the heading is 7 wide with its tags: p starts at 8).
    act(() => {
      editor.commands.setTextSelection(8 + 1 + 6 + 2);
    });
    expect(pressed()).toEqual(["Bold"]);
    act(() => {
      editor.commands.setTextSelection(8 + 1 + 2);
    });
    expect(pressed()).toEqual([]);
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("toggles marks", () => {
    const editor = setup();
    click("Bold");
    expect(editor.isActive("bold")).toBe(true);
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    click("Bold");
    expect(editor.isActive("bold")).toBe(false);
    click("Italic");
    expect(editor.isActive("italic")).toBe(true);
    click("Inline code");
    expect(editor.isActive("code")).toBe(true);
  });

  it("toggles headings, lists and code blocks", () => {
    const editor = setup();
    click("Heading 2");
    expect(editor.isActive("heading", { level: 2 })).toBe(true);
    click("Heading 2");
    expect(editor.isActive("heading")).toBe(false);
    click("Bulleted list");
    expect(editor.isActive("bulletList")).toBe(true);
    click("Bulleted list");
    click("Numbered list");
    expect(editor.isActive("orderedList")).toBe(true);
    click("Numbered list");
    click("Task list");
    expect(editor.isActive("taskList")).toBe(true);
    click("Task list");
    click("Code block");
    expect(editor.isActive("codeBlock")).toBe(true);
  });

  it("adds an https link from the popover", async () => {
    const editor = setup();
    click("Link");
    const input = await screen.findByLabelText("Link URL");
    fireEvent.change(input, { target: { value: "example.com/docs" } });
    act(() => {
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    expect(editor.getAttributes("link").href).toBe("https://example.com/docs");
  });

  it("refuses a disallowed link with a message, and it never enters the Y.Doc", async () => {
    const { ydoc, editor } = collab("<p>hello world</p>");
    render(
      <TooltipProvider>
        <Toolbar editor={editor} />
      </TooltipProvider>,
    );
    editor.commands.selectAll();
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "ftp://x.example",
      "JaVaScRiPt:alert(1)",
    ]) {
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Link" }));
      });
      const input = await screen.findByLabelText("Link URL");
      fireEvent.change(input, { target: { value: bad } });
      act(() => {
        fireEvent.submit(input.closest("form") as HTMLFormElement);
      });
      expect(await screen.findByRole("alert")).toHaveTextContent(LINK_REFUSED);
      expect(linkHrefs(ydoc)).toEqual([]);
      act(() => {
        fireEvent.keyDown(input, { key: "Escape" });
      });
    }
    expect(LINK_REFUSED).toBe(
      "Links must start with http://, https:// or mailto:",
    );
  });
});

describe("links never reach the Y.Doc unless allowed", () => {
  it("accepts http, https and mailto only, in any case", () => {
    expect(toAllowedHref("http://a.example")).toBe("http://a.example");
    expect(toAllowedHref("HTTPS://a.example")).toBe("HTTPS://a.example");
    expect(toAllowedHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(toAllowedHref("a.example/x")).toBe("https://a.example/x");
    expect(toAllowedHref("localhost:3000/x")).toBeNull();
    for (const bad of [
      "javascript:alert(1)",
      "vbscript:x",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://a.example",
      "//a.example",
      "/relative",
      "java script:x",
      "",
      "   ",
      "nodots",
    ])
      expect(toAllowedHref(bad), bad).toBeNull();
  });

  it("setLink refuses a disallowed href", () => {
    const { ydoc, editor } = collab();
    editor.commands.selectAll();
    expect(editor.commands.setLink({ href: "javascript:alert(1)" })).toBe(
      false,
    );
    expect(linkHrefs(ydoc)).toEqual([]);
    editor.commands.selectAll();
    expect(editor.commands.setLink({ href: "https://ok.example" })).toBe(true);
    expect(linkHrefs(ydoc)).toEqual(["https://ok.example"]);
  });

  it("pasted or inserted HTML with a javascript: link is not a link", () => {
    const { ydoc, editor } = collab();
    editor.commands.setContent(
      '<p><a href="javascript:alert(1)">x</a> <a href="data:text/html,y">y</a> <a href="https://ok.example">ok</a></p>',
    );
    expect(linkHrefs(ydoc)).toEqual(["https://ok.example"]);
  });

  it("a transaction that adds a bad link mark is dropped before the Y.Doc", () => {
    const { ydoc, editor } = collab();
    const { state, view } = editor;
    // docSchema has the same link mark; build it on the editor's own schema.
    const mark = state.schema.marks.link.create({
      href: "javascript:alert(1)",
    });
    view.dispatch(state.tr.addMark(1, 6, mark));
    expect(linkHrefs(ydoc)).toEqual([]);
    const ok = state.schema.marks.link.create({ href: "https://ok.example" });
    view.dispatch(editor.state.tr.addMark(1, 6, ok));
    expect(linkHrefs(ydoc)).toEqual(["https://ok.example"]);
  });
});

describe("DocEditor", () => {
  const base = {
    artifactId: "A1",
    title: "Plan",
    viewer: { name: "Leo" },
    outsider: false,
  };

  it("is editable with a toolbar when the viewer can edit", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    expect(
      await screen.findByRole("toolbar", { name: "Formatting" }),
    ).toBeVisible();
    expect(
      document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
    ).toBe("true");
  });

  it("is not editable before the room's hello, even when the page says it can edit", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    await screen.findByRole("textbox", { name: "Plan" });
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(
      document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
    ).toBe("false");
  });

  it("a hello at the cap is the doc-full state: read-only, the full message", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    const f = p.made.last as NonNullable<typeof p.made.last>;
    f.autoHello = { bytes: 2097152, cap: 2097152 };
    act(() => f.connect());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This doc is full (2 MB).",
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("reports the hello's version to onCurrentVersion", async () => {
    const p = fakeProviders();
    const onCurrentVersion = vi.fn();
    render(
      <DocEditor
        {...base}
        canEdit
        makeProvider={p.make}
        onCurrentVersion={onCurrentVersion}
      />,
    );
    const f = p.made.last as NonNullable<typeof p.made.last>;
    f.autoHello = { version: 7 };
    act(() => f.connect());
    await waitFor(() => expect(onCurrentVersion).toHaveBeenCalledWith(7));
  });

  it("is not editable and has no toolbar when the viewer cannot edit", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit={false} makeProvider={p.make} />);
    await screen.findByRole("textbox", { name: "Plan" });
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(
      document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
    ).toBe("false");
  });

  it("shows the size message on a doc_too_large error frame", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    act(() => {
      p.made.last?.connect();
      p.made.last?.frame(
        JSON.stringify({ type: "error", code: "doc_too_large" }),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This doc is full (2 MB).",
    );
  });

  it("the full message says it is full, names no plan, and offers the two next steps", async () => {
    const p = fakeProviders();
    render(
      <DocEditor
        {...base}
        canEdit
        makeProvider={p.make}
        fullActions={
          <>
            <button type="button">New doc</button>
            <button type="button">Version history</button>
          </>
        }
      />,
    );
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    // Not full: no message, no buttons.
    expect(
      screen.queryByRole("button", { name: "Version history" }),
    ).toBeNull();
    act(() => p.made.last?.connect());
    act(() =>
      p.made.last?.frame(
        JSON.stringify({ type: "error", code: "doc_too_large" }),
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^This doc is full \(2 MB\)\.$/,
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(/plan|upgrade/i);
    expect(screen.getByRole("button", { name: "New doc" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Version history" }),
    ).toBeVisible();
  });

  it("on doc_too_large goes read-only, then resyncs into a fresh Y.Doc without the rejected text", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    const first = p.made.last as NonNullable<typeof p.made.last>;
    act(() => first.connect());
    // A local edit the server will reject.
    act(() => {
      const para = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "rejected text");
      para.insert(0, [text]);
      first.doc.getXmlFragment("default").insert(0, [para]);
    });
    await waitFor(() =>
      expect(document.querySelector(".ProseMirror")?.textContent).toContain(
        "rejected text",
      ),
    );
    const frame = JSON.stringify({ type: "error", code: "doc_too_large" });
    act(() => first.frame(frame));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This doc is full (2 MB).",
    );
    // A new provider on a new Y.Doc; the old room is gone.
    await waitFor(() => expect(p.made.last).not.toBe(first));
    const second = p.made.last as NonNullable<typeof p.made.last>;
    expect(second.doc).not.toBe(first.doc);
    expect(first.destroyed).toBe(true);
    expect(first.sentUpdates).toHaveLength(0);
    act(() => second.connect());
    await waitFor(() =>
      expect(document.querySelector(".ProseMirror")?.textContent).not.toContain(
        "rejected text",
      ),
    );
    // Still read-only with the message.
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(
      document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
    ).toBe("false");
    // A repeat error does not rebuild again.
    act(() => second.frame(frame));
    await new Promise((r) => setTimeout(r, 20));
    expect(p.made.last).toBe(second);
  });

  it("an empty doc shows the placeholder, and a typed one does not", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    const empty = () => document.querySelector("p.oa-doc-empty");
    expect(empty()?.getAttribute("data-placeholder")).toBe(
      "Start writing. Use the toolbar for headings, lists and more.",
    );
    act(() => {
      const para = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "hi");
      para.insert(0, [text]);
      (p.made.last as NonNullable<typeof p.made.last>).doc
        .getXmlFragment("default")
        .insert(0, [para]);
    });
    await waitFor(() => expect(empty()).toBeNull());
  });

  it("an existing doc opens with the cursor in the body, once synced", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    expect(document.querySelector(".ProseMirror")).not.toHaveFocus();
    act(() => p.made.last?.connect());
    await waitFor(() =>
      expect(document.querySelector(".ProseMirror")).toHaveFocus(),
    );
  });

  it("a new doc opens with the title focused and all of it selected", async () => {
    const p = fakeProviders();
    markFresh("A1");
    render(<DocEditor {...base} canEdit fresh makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    act(() => p.made.last?.connect());
    const title = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Title",
    });
    await waitFor(() => expect(title).toHaveFocus());
    expect([title.selectionStart, title.selectionEnd]).toEqual([
      0,
      "Plan".length,
    ]);
    expect(document.querySelector(".ProseMirror")).not.toHaveFocus();
    // Used up: a later open of this doc is not new.
    expect(isFresh("A1")).toBe(false);
  });

  it("typing in the title when the room syncs keeps the cursor there (existing doc)", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    const title = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Title",
    });
    act(() => title.focus());
    fireEvent.change(title, { target: { value: "Plan B" } });
    act(() => p.made.last?.connect());
    await new Promise((r) => setTimeout(r, 50));
    expect(title).toHaveFocus();
    expect(title.value).toBe("Plan B");
    expect(document.querySelector(".ProseMirror")).not.toHaveFocus();
  });

  it("typing in the title when the room syncs does not select it (new doc)", async () => {
    const p = fakeProviders();
    markFresh("A1");
    render(<DocEditor {...base} canEdit fresh makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    const title = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Title",
    });
    act(() => title.focus());
    fireEvent.change(title, { target: { value: "Mine" } });
    title.setSelectionRange(4, 4);
    act(() => p.made.last?.connect());
    await new Promise((r) => setTimeout(r, 50));
    expect(title).toHaveFocus();
    expect([title.selectionStart, title.selectionEnd]).toEqual([4, 4]);
  });

  it("the title is the first line of the editing column", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    const page = document.querySelector(".oa-doc-page");
    expect(page?.firstElementChild).toBe(
      screen.getByRole("textbox", { name: "Title" }),
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveAttribute(
      "placeholder",
      "Untitled",
    );
  });

  it("Enter and Down in the title move to the body", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    const title = screen.getByRole("textbox", { name: "Title" });
    for (const key of ["Enter", "ArrowDown"]) {
      act(() => title.focus());
      fireEvent.keyDown(title, { key });
      await waitFor(() =>
        expect(document.querySelector(".ProseMirror")).toHaveFocus(),
      );
    }
  });

  describe("the New doc toast", () => {
    const showToast = () =>
      toast({
        title: "Type a title, then press Enter to start writing.",
        tone: "neutral",
        id: NEW_DOC_TOAST,
      });
    const open = async () => {
      const p = fakeProviders();
      render(
        <>
          <Toaster />
          <DocEditor {...base} canEdit makeProvider={p.make} />
        </>,
      );
      // The room says hello (edit) on open: only then is it editable.
      act(() => p.made.last?.connect(false));
      await screen.findByRole("toolbar");
      act(() => void showToast());
      await screen.findByText(
        "Type a title, then press Enter to start writing.",
      );
    };
    const gone = () =>
      waitFor(() =>
        expect(
          screen.queryByText(
            "Type a title, then press Enter to start writing.",
          ),
        ).toBeNull(),
      );

    it("goes away on Enter in the title", async () => {
      await open();
      const title = screen.getByRole("textbox", { name: "Title" });
      fireEvent.keyDown(title, { key: "Enter" });
      await gone();
    });

    it("goes away on the first key in the body", async () => {
      await open();
      const body = document.querySelector(".ProseMirror") as HTMLElement;
      fireEvent.keyDown(body, { key: "a" });
      await gone();
    });

    it("stays while the person only looks or types in the title", async () => {
      await open();
      const title = screen.getByRole("textbox", { name: "Title" });
      fireEvent.change(title, { target: { value: "Plan B" } });
      await new Promise((r) => setTimeout(r, 50));
      expect(
        screen.getByText("Type a title, then press Enter to start writing."),
      ).toBeVisible();
    });
  });

  it("a read-only viewer cannot edit the title", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit={false} makeProvider={p.make} />);
    const title = await screen.findByRole("textbox", { name: "Title" });
    expect(title).toHaveAttribute("readonly");
  });

  describe("the wire spec", () => {
    const hello = (role: string, extra: object = {}) =>
      JSON.stringify({
        type: "hello",
        role,
        bytes: 1000,
        cap: 2097152,
        ...extra,
      });
    const readOnly = () =>
      expect(
        document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
      ).toBe("false");
    const open = async () => {
      const p = fakeProviders();
      render(<DocEditor {...base} canEdit makeProvider={p.make} />);
      // The room says hello (edit) on open: only then is it editable.
      act(() => p.made.last?.connect(false));
      await screen.findByRole("toolbar");
      const f = p.made.last as NonNullable<typeof p.made.last>;
      act(() => f.connect());
      return { p, f };
    };

    // A checklist from the server (as if another person wrote it).
    const seedTasks = (f: { doc: Y.Doc }, origin: unknown) => {
      const item = (text: string, checked: boolean) => {
        const p = new Y.XmlElement("paragraph");
        p.insert(0, [new Y.XmlText(text)]);
        const li = new Y.XmlElement("taskItem");
        li.setAttribute("checked", checked as unknown as string);
        li.insert(0, [p]);
        return li;
      };
      f.doc.transact(() => {
        const list = new Y.XmlElement("taskList");
        list.insert(0, [item("Done", true), item("Open", false)]);
        f.doc.getXmlFragment("default").insert(0, [list]);
      }, origin);
    };
    const checks = () =>
      [
        ...document.querySelectorAll<HTMLInputElement>(
          '.ProseMirror input[type="checkbox"]',
        ),
      ].map((c) => c.checked);
    const attrs = (f: { doc: Y.Doc }) =>
      f.doc
        .getXmlFragment("default")
        .toArray()
        .flatMap((l) => (l as Y.XmlElement).toArray())
        .map((li) => (li as Y.XmlElement).getAttribute("checked"));

    it("an editor can tick a checklist box (the control for the tests below)", async () => {
      const { f } = await open();
      act(() => seedTasks(f, f));
      await waitFor(() => expect(checks()).toEqual([true, false]));
      const sent = f.sentUpdates.length;
      const boxes = document.querySelectorAll<HTMLInputElement>(
        '.ProseMirror input[type="checkbox"]',
      );
      fireEvent.click(boxes[1] as HTMLInputElement);
      await waitFor(() => expect(attrs(f)).toEqual([true, true]));
      await waitFor(() => expect(f.sentUpdates.length).toBeGreaterThan(sent));
    });

    for (const [name, enter] of [
      [
        "View only (read, access)",
        (f: FakeLike) => f.frame(hello("read", { reason: "access" })),
      ],
      [
        "a full room (read, room_full)",
        (f: FakeLike) => f.frame(hello("read", { reason: "room_full" })),
      ],
      ["a deleted doc (4404)", (f: FakeLike) => f.close(4404)],
    ] as const)
      it(`a checklist box cannot be ticked in ${name}: no change, nothing sent`, async () => {
        const { f } = await open();
        act(() => seedTasks(f, f));
        await waitFor(() => expect(checks()).toEqual([true, false]));
        act(() => enter(f));
        await waitFor(() => readOnly());
        // Let anything already queued go out (the editor may normalize the
        // seeded content, a send within the 75 ms batch) before counting.
        await new Promise((r) => setTimeout(r, 200));
        const sent = f.sentUpdates.length;
        for (const box of document.querySelectorAll<HTMLInputElement>(
          '.ProseMirror input[type="checkbox"]',
        ))
          fireEvent.click(box);
        // Past the 75 ms send batch.
        await new Promise((r) => setTimeout(r, 200));
        expect(checks()).toEqual([true, false]);
        expect(attrs(f)).toEqual([true, false]);
        expect(f.sentUpdates.length).toBe(sent);
      });

    it("access removed shows no status where Saved sits", async () => {
      const p = fakeProviders();
      const seen: (string | null)[] = [];
      render(
        <DocEditor
          {...base}
          canEdit
          makeProvider={p.make}
          onStatus={(s) => seen.push(s)}
        />,
      );
      const f = p.made.last as NonNullable<typeof p.made.last>;
      f.autoHello = null;
      act(() => f.connect());
      act(() => f.close(4403));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "You no longer have access.",
      );
      expect(seen.at(-1)).toBeNull();
    });

    it("logged out: the notice, a Log in link (new tab) back here, read-only, no status; focus after signing in resumes", async () => {
      const p = fakeProviders();
      const seen: (string | null)[] = [];
      let signedIn = false;
      render(
        <DocEditor
          {...base}
          canEdit
          makeProvider={p.make}
          checkAuth={async () => signedIn}
          onStatus={(s) => seen.push(s)}
        />,
      );
      const f = p.made.last as NonNullable<typeof p.made.last>;
      act(() => f.connect());
      await screen.findByRole("toolbar");
      act(() => f.close(4401));
      f.refuse = true;
      await waitFor(() => expect(f.connects).toBe(2), { timeout: 2000 });
      act(() => f.close(1006));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "You've been logged out. Your changes are saved. Log in again to keep editing.",
      );
      expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute(
        "href",
        `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`,
      );
      const link = screen.getByRole("link", { name: "Log in" });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener");
      readOnly();
      expect(screen.queryByRole("toolbar")).toBeNull();
      expect(seen.at(-1)).toBeNull();
      // Signed in in the other tab; this one gets focus back.
      signedIn = true;
      f.refuse = false;
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(await screen.findByRole("toolbar")).toBeVisible();
      await waitFor(() => expect(seen.at(-1)).toBe("saved"));
    });

    it("signed in again with nothing unsent, still refused: Reconnecting…, read-only, no notice yet", async () => {
      const p = fakeProviders();
      const seen: (string | null)[] = [];
      let signedIn = false;
      render(
        <DocEditor
          {...base}
          canEdit
          makeProvider={p.make}
          checkAuth={async () => signedIn}
          onStatus={(s) => seen.push(s)}
        />,
      );
      const f = p.made.last as NonNullable<typeof p.made.last>;
      act(() => f.connect());
      await screen.findByRole("toolbar");
      act(() => f.close(4401));
      f.refuse = true;
      await waitFor(() => expect(f.connects).toBe(2), { timeout: 2000 });
      act(() => f.close(1006));
      await screen.findByRole("alert");
      signedIn = true;
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(f.connects).toBe(3));
      act(() => f.close(1006));
      await waitFor(() => expect(seen.at(-1)).toBe("reconnecting"));
      expect(STATUS_TEXT.reconnecting).toBe("Reconnecting…");
      readOnly();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("toolbar")).toBeNull();
    });

    it("holding unsent edits: the warning band and the leave warning, both gone once delivered", async () => {
      const p = fakeProviders();
      let signedIn = false;
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      const leave = () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      };
      try {
        render(
          <DocEditor
            {...base}
            canEdit
            makeProvider={p.make}
            checkAuth={async () => signedIn}
          />,
        );
        const f = p.made.last as NonNullable<typeof p.made.last>;
        f.server = new Y.Doc();
        act(() => f.connect());
        await screen.findByRole("toolbar");
        expect(leave()).toBe(false);
        act(() => f.close(4401));
        // Written while the socket is down: unsent.
        act(() => {
          f.doc.getText("t").insert(0, "offline");
        });
        await new Promise((r) => setTimeout(r, 150));
        f.refuse = true;
        await waitFor(() => expect(f.connects).toBe(2), { timeout: 2000 });
        act(() => f.close(1006));
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(
          "You've been logged out. Keep this page open and log in; your latest changes will be saved after.",
        );
        const band = alert.closest(".oa-doc-error");
        expect(band).toHaveAttribute("data-tone", "warning");
        expect(band?.querySelector("svg.oa-doc-error-icon")).not.toBeNull();
        const warn = add.mock.calls.find((c) => c[0] === "beforeunload")?.[1];
        expect(warn).toBeTypeOf("function");
        expect(leave()).toBe(true);
        // Signed in again: resumes and delivers; the listener goes.
        signedIn = true;
        f.refuse = false;
        act(() => {
          window.dispatchEvent(new Event("focus"));
        });
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
        expect(f.server?.getText("t").toString()).toBe("offline");
        expect(
          remove.mock.calls.some(
            (c) => c[0] === "beforeunload" && c[1] === warn,
          ),
        ).toBe(true);
        expect(leave()).toBe(false);
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    });

    it("logged out with nothing unsent: the plain band, no leave warning", async () => {
      const p = fakeProviders();
      render(
        <DocEditor
          {...base}
          canEdit
          makeProvider={p.make}
          checkAuth={async () => false}
        />,
      );
      const f = p.made.last as NonNullable<typeof p.made.last>;
      act(() => f.connect());
      await screen.findByRole("toolbar");
      act(() => f.close(4401));
      f.refuse = true;
      await waitFor(() => expect(f.connects).toBe(2), { timeout: 2000 });
      act(() => f.close(1006));
      const alert = await screen.findByRole("alert");
      expect(alert.closest(".oa-doc-error")).not.toHaveAttribute("data-tone");
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    });

    it("a deleted doc shows no status where Saved sits", async () => {
      const p = fakeProviders();
      const seen: (string | null)[] = [];
      render(
        <DocEditor
          {...base}
          canEdit
          makeProvider={p.make}
          onStatus={(s) => seen.push(s)}
        />,
      );
      const f = p.made.last as NonNullable<typeof p.made.last>;
      act(() => f.connect());
      await screen.findByRole("toolbar");
      expect(seen.at(-1)).toBe("saved");
      act(() => f.close(4404));
      await screen.findByRole("alert");
      expect(seen.at(-1)).toBeNull();
    });

    it("a viewer's hello (read, access) makes it read-only with no toolbar and no banner", async () => {
      const { f } = await open();
      act(() => f.frame(hello("read", { reason: "access" })));
      await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
      readOnly();
      expect(screen.queryByRole("status", { name: "" })).toBeNull();
      expect(screen.queryByText(/editing opens/)).toBeNull();
    });

    it("a reader, by access or in a full room, is labelled View only where Saved sits", async () => {
      const p = fakeProviders();
      const seen: (string | null)[] = [];
      render(
        <DocEditor
          {...base}
          canEdit
          makeProvider={p.make}
          onStatus={(s) => seen.push(s)}
        />,
      );
      const f = p.made.last as NonNullable<typeof p.made.last>;
      act(() => f.connect());
      await screen.findByRole("toolbar");
      expect(seen.at(-1)).toBe("saved");
      act(() => f.frame(hello("read", { reason: "access" })));
      expect(seen.at(-1)).toBe("view");
      expect(STATUS_TEXT.view).toBe("View only");
      act(() => f.frame(hello("read", { reason: "room_full" })));
      expect(seen.at(-1)).toBe("view");
    });

    it("a page-side viewer (cannot edit) is View only too", async () => {
      const p = fakeProviders();
      const seen: (string | null)[] = [];
      render(
        <DocEditor
          {...base}
          canEdit={false}
          makeProvider={p.make}
          onStatus={(s) => seen.push(s)}
        />,
      );
      await waitFor(() => expect(seen.at(-1)).toBe("view"));
    });

    it("an edit hello leaves it editable", async () => {
      const { f } = await open();
      act(() => f.frame(hello("edit")));
      expect(screen.getByRole("toolbar")).toBeVisible();
    });

    it("a full room reads only, says why, and Try again reconnects", async () => {
      const { f } = await open();
      act(() => f.frame(hello("read", { reason: "room_full" })));
      expect(
        await screen.findByText(
          "This doc is full right now. You can read it, and editing opens when someone leaves.",
        ),
      ).toBeVisible();
      readOnly();
      const before = f.connects;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(f.connects).toBe(before + 1);
    });

    it("warns near the cap and stays editable", async () => {
      const { f } = await open();
      act(() => f.frame(hello("edit", { bytes: 1_950_000 })));
      expect(
        await screen.findByText(
          "This doc is almost full (1.9 of 2 MB). Images take the most space.",
        ),
      ).toBeVisible();
      expect(screen.getByRole("toolbar")).toBeVisible();
    });

    it("4403 after a hello reconnects; a hello keeps it editable (an access change, #2490)", async () => {
      const { f } = await open();
      const before = f.connects;
      act(() => f.close(4403));
      await waitFor(() => expect(f.connects).toBe(before + 1));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(await screen.findByRole("toolbar")).toBeVisible();
    });

    it("4403, then a reconnect refused before any hello, says you no longer have access", async () => {
      const { f } = await open();
      const before = f.connects;
      f.autoHello = null;
      act(() => f.close(4403));
      await waitFor(() => expect(f.connects).toBe(before + 1));
      // A browser sees the route's 404 as a 1006 close.
      act(() => f.close(1006));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "You no longer have access.",
      );
      readOnly();
      expect(screen.queryByRole("toolbar")).toBeNull();
    });

    it("4404 says the doc is gone", async () => {
      const { f } = await open();
      act(() => f.close(4404));
      expect((await screen.findByRole("alert")).textContent).toBe(
        "This doc was deleted. Its owner can restore it from Trash.",
      );
    });

    it("1007 twice stops and reports; once is only a resync", async () => {
      const { f } = await open();
      act(() => f.close(1007));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole("alert")).toBeNull();
      act(() => f.close(1007));
      expect((await screen.findByRole("alert")).textContent).toBe(
        "This doc can't sync right now. Reload the page to try again. Copy any unsaved changes first.",
      );
    });

    it("passes the room's saved and restored events to onVersion", async () => {
      const onVersion = vi.fn();
      const p = fakeProviders();
      render(
        <DocEditor
          {...base}
          canEdit
          makeProvider={p.make}
          onVersion={onVersion}
        />,
      );
      // The room says hello (edit) on open: only then is it editable.
      act(() => p.made.last?.connect(false));
      await screen.findByRole("toolbar");
      const f = p.made.last as NonNullable<typeof p.made.last>;
      act(() => f.connect());
      act(() =>
        f.frame(JSON.stringify({ type: "saved", version: 5, auto: true })),
      );
      act(() =>
        f.frame(JSON.stringify({ type: "restored", from: 2, version: 6 })),
      );
      expect(onVersion.mock.calls.map((c) => c[0])).toEqual([
        { kind: "saved", version: 5, auto: true },
        { kind: "restored", from: 2, version: 6 },
      ]);
      // The doc stays editable and shows no alert.
      expect(screen.getByRole("toolbar")).toBeVisible();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("rate_limited shows nothing and leaves it editable", async () => {
      const { f } = await open();
      act(() =>
        f.frame(JSON.stringify({ type: "error", code: "rate_limited" })),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("toolbar")).toBeVisible();
    });

    it("4401 and 1013 show nothing", async () => {
      const { f } = await open();
      act(() => f.close(4401));
      act(() => f.close(1013));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status", { name: "" })).toBeNull();
    });
  });

  it("reports Saving, Saved and Offline for the title bar", async () => {
    const p = fakeProviders();
    const seen: (string | null)[] = [];
    render(
      <DocEditor
        {...base}
        canEdit
        makeProvider={p.make}
        onStatus={(s) => seen.push(s)}
      />,
    );
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    act(() => p.made.last?.connect());
    expect(seen.at(-1)).toBe("saved");
    act(() => p.made.last?.disconnect());
    expect(seen.at(-1)).toBe("offline");
    act(() => p.made.last?.connect(false));
    expect(seen.at(-1)).toBe("saving");
  });

  it("leaves the room on unmount", async () => {
    const p = fakeProviders();
    const view = render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    const fake = p.made.last;
    view.unmount();
    expect(fake?.destroyed).toBe(true);
  });
});

describe("cursor name flags", () => {
  it("renders a caret with a flag and a collapsed dot; an agent's mark is a square", () => {
    const user = renderCaret(
      { name: "Maya", color: "#c2410c", kind: "user" },
      false,
    );
    expect(user.dataset.kind).toBe("user");
    expect(user.querySelector(".oa-doc-dot")).not.toBeNull();
    expect(user.querySelector(".oa-doc-flag")?.textContent).toBe("Maya");
    expect(user.hasAttribute("data-active")).toBe(false);
    const agent = renderCaret(
      { name: "Docs agent", color: "#9333ea", kind: "agent" },
      false,
    );
    expect(agent.dataset.kind).toBe("agent");
    // No face fields (an unlinked agent): AuthorFace's dashed robot.
    expect(
      agent.querySelector('.oa-doc-flag-face [data-avatar="agent"]'),
    ).toHaveAttribute("data-linked", "false");
  });

  it("an agent's flag leads with its AuthorFace tile; an outsider sees the dashed robot and 'Agent'", () => {
    const u = {
      name: "OA Product",
      color: "#9333ea",
      kind: "agent" as const,
      linked: true,
      animal: { id: "duck", color: 6 },
    };
    const tile = renderCaret(u, false).querySelector(
      '.oa-doc-flag-face [data-avatar="agent"]',
    );
    expect(tile).toHaveAttribute("data-linked", "true");
    expect(tile).toHaveAttribute("data-animal", "duck");
    expect(tile?.getAttribute("style")).toContain("--oa-presence-6");
    const outside = renderCaret(u, true);
    expect(outside.querySelector(".oa-doc-flag")?.textContent).toBe("Agent");
    const robot = outside.querySelector(
      '.oa-doc-flag-face [data-avatar="agent"]',
    );
    expect(robot).toHaveAttribute("data-linked", "false");
    expect(robot?.hasAttribute("data-animal")).toBe(false);
    // A person's flag has no face.
    expect(
      renderCaret({ name: "Maya", kind: "user" }, false).querySelector(
        ".oa-doc-flag-face",
      ),
    ).toBeNull();
  });

  it("opens a flag on a move and closes it after 2 s", () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement("div");
      const a = renderCaret({ name: "Maya" }, false);
      const b = renderCaret({ name: "Sam" }, false);
      root.append(a, b);
      const activity = new CaretActivity(() => root);
      activity.touch("Maya");
      expect(a.hasAttribute("data-active")).toBe(true);
      expect(b.hasAttribute("data-active")).toBe(false);
      vi.advanceTimersByTime(FLAG_MS - 1);
      expect(a.hasAttribute("data-active")).toBe(true);
      // A move resets the 2 s.
      activity.touch("Maya");
      vi.advanceTimersByTime(FLAG_MS - 1);
      expect(a.hasAttribute("data-active")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(a.hasAttribute("data-active")).toBe(false);
      // A caret built while a flag is open starts open.
      activity.touch("Sam");
      expect(renderCaret({ name: "Sam" }, false, activity).dataset.active).toBe(
        "",
      );
      expect(FLAG_MS).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a remote cursor that moves opens its flag in the editor; one that does not, does not", async () => {
    const p = fakeProviders();
    render(
      <DocEditor
        {...{
          artifactId: "A1",
          title: "Plan",
          viewer: { name: "Leo" },
          outsider: false,
        }}
        canEdit
        makeProvider={p.make}
      />,
    );
    // The room says hello (edit) on open: only then is it editable.
    act(() => p.made.last?.connect(false));
    await screen.findByRole("toolbar");
    const fake = p.made.last as NonNullable<typeof p.made.last>;
    act(() => fake.connect());
    const ydoc = fake.doc;
    act(() => {
      ydoc.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
    });
    const para = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
    const text = new Y.XmlText("hello world");
    act(() => para.insert(0, [text]));
    const remote = new Y.Doc();
    const { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } =
      await import("y-protocols/awareness");
    const ra = new Awareness(remote);
    const at = (i: number) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, i));
    const send = (
      i: number,
      user = { name: "Maya Chen", color: "#c2410c", kind: "user" },
    ) => {
      ra.setLocalState({ user, cursor: { anchor: at(i), head: at(i) } });
      applyAwarenessUpdate(
        fake.awareness,
        encodeAwarenessUpdate(ra, [ra.clientID]),
        "remote",
      );
    };
    const caret = () =>
      document.querySelector<HTMLElement>(
        '.oa-doc-caret[data-key="Maya Chen"]',
      );
    send(3);
    await waitFor(() => expect(caret()).not.toBeNull());
    expect(caret()?.hasAttribute("data-active")).toBe(true);
    await waitFor(
      () => expect(caret()?.hasAttribute("data-active")).toBe(false),
      {
        timeout: FLAG_MS + 1500,
      },
    );
    // The same position again (a heartbeat): no flag.
    send(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(caret()?.hasAttribute("data-active")).toBe(false);
    // A move: open again.
    send(6);
    await waitFor(() =>
      expect(caret()?.hasAttribute("data-active")).toBe(true),
    );
  }, 10000);
});

describe("isDocArtifact", () => {
  it("is the doc format, or the mock's named id", () => {
    expect(isDocArtifact({ id: "a", format: "doc" })).toBe(true);
    expect(isDocArtifact({ id: "a", format: "markdown" })).toBe(false);
    setMockDoc("m");
    expect(isDocArtifact({ id: "m", format: "html" })).toBe(true);
    setMockDoc(null);
    expect(isDocArtifact({ id: "m", format: "html" })).toBe(false);
  });
});

describe("TitleField saving", () => {
  function field(title = "Plan") {
    const onSave = vi.fn();
    const ref = { current: null as HTMLInputElement | null };
    const view = render(
      <TitleField
        title={title}
        editable
        onSave={onSave}
        onEnter={() => {}}
        inputRef={ref}
      />,
    );
    return {
      onSave,
      input: screen.getByRole("textbox", { name: "Title" }),
      view,
    };
  }
  const type = (input: HTMLElement, text: string) =>
    fireEvent.change(input, { target: { value: text } });

  it("saves after a pause in typing, once", () => {
    vi.useFakeTimers();
    try {
      const { onSave, input } = field();
      type(input, "Launch");
      type(input, "Launch plan");
      vi.advanceTimersByTime(TITLE_SAVE_MS - 1);
      expect(onSave).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onSave).toHaveBeenCalledExactlyOnceWith("Launch plan");
      vi.advanceTimersByTime(5000);
      expect(onSave).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves at once on blur, trimmed, and not again after the pause", () => {
    vi.useFakeTimers();
    try {
      const { onSave, input } = field();
      type(input, "  Roadmap  ");
      fireEvent.blur(input);
      expect(onSave).toHaveBeenCalledExactlyOnceWith("Roadmap");
      vi.advanceTimersByTime(5000);
      expect(onSave).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty title saves as Untitled", () => {
    const { onSave, input } = field("Plan");
    type(input, "   ");
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Untitled");
  });

  it("saves nothing when the title did not change", () => {
    const { onSave, input } = field("Plan");
    type(input, "Plan");
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a rename from elsewhere shows after blur when the field was untouched", () => {
    const onSave = vi.fn();
    const ref = { current: null as HTMLInputElement | null };
    const props = {
      editable: true,
      onSave,
      onEnter: () => {},
      inputRef: ref,
    };
    const view = render(<TitleField title="Plan" {...props} />);
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Title",
    });
    act(() => input.focus());
    view.rerender(<TitleField title="Roadmap" {...props} />);
    // Focused and untouched: the field is left alone while the cursor is in it.
    expect(input.value).toBe("Plan");
    fireEvent.blur(input);
    expect(input.value).toBe("Roadmap");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a pending edit is saved when the field goes away", () => {
    vi.useFakeTimers();
    try {
      const { onSave, input, view } = field();
      type(input, "Gone soon");
      view.unmount();
      expect(onSave).toHaveBeenCalledExactlyOnceWith("Gone soon");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DocState (the title bar's doc state)", () => {
  it("carries an icon for each state but View only; its text is the name and the title", () => {
    const cases = [
      ["saving", "Saving…", true],
      ["reconnecting", "Reconnecting…", true],
      ["connecting", "Connecting…", true],
      ["saved", "Saved", false],
      ["offline", "Offline", false],
    ] as const;
    for (const [label, text, spin] of cases) {
      const { unmount } = render(<DocState label={label} />);
      const s = screen.getByRole("status");
      expect(s).toHaveTextContent(text);
      expect(s).toHaveAttribute("title", text);
      const icon = s.querySelector("svg.oa-docstate-icon");
      expect(icon, label).not.toBeNull();
      expect(icon?.hasAttribute("data-spin"), label).toBe(spin);
      unmount();
    }
    const { unmount } = render(<DocState label="view" />);
    expect(screen.getByRole("status")).toHaveTextContent("View only");
    expect(screen.getByRole("status").querySelector("svg")).toBeNull();
    unmount();
  });

  it("a version note takes the text, name and title", () => {
    render(<DocState label="saved" note="Saved as v5" />);
    const s = screen.getByRole("status");
    expect(s).toHaveTextContent("Saved as v5");
    expect(s).toHaveAttribute("title", "Saved as v5");
  });
});
