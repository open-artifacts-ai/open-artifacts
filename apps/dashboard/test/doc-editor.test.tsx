import { docSchema, yXmlFragmentToDoc } from "@oa/doc-schema";
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
import { CaretActivity, FLAG_MS, renderCaret } from "../src/viewer/doc/cursors";
import { DocEditor } from "../src/viewer/doc/DocEditor";
import { isDocArtifact, setMockDoc } from "../src/viewer/doc/docMock";
import {
  contentExtensions,
  LINK_REFUSED,
  toAllowedHref,
} from "../src/viewer/doc/extensions";
import { ariaShortcut, shortcutText, Toolbar } from "../src/viewer/doc/Toolbar";
import { fakeProviders } from "./doc-fake-provider";

// Radix's tooltip measures its arrow; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
    expect(ours.nodes.heading.spec.content).toBe("inline*");
    expect(ours.marks.code.excludes(ours.marks.link)).toBe(false);
    // No Tiptap-only nodes or marks sneak in (hardBreak, underline).
    expect(ours.nodes.hardBreak).toBeUndefined();
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

  it("Shift+Enter never puts a line break node in a heading (hardBreak is not in the schema yet, #2178)", () => {
    const { editor } = collab("<h2>Title</h2>");
    editor.commands.setTextSelection(3);
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
    expect(JSON.stringify(editor.getJSON())).not.toContain("hardBreak");
    expect(editor.schema.nodes.hardBreak).toBeUndefined();
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
    expect(
      await screen.findByRole("toolbar", { name: "Formatting" }),
    ).toBeVisible();
    expect(
      document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
    ).toBe("true");
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
    await screen.findByRole("toolbar");
    act(() => {
      p.made.last?.connect();
      p.made.last?.frame(
        JSON.stringify({ type: "error", code: "doc_too_large" }),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This doc is at its size limit for your plan.",
    );
  });

  it("on doc_too_large goes read-only with the size message, then reconnects once", async () => {
    const p = fakeProviders();
    render(<DocEditor {...base} canEdit makeProvider={p.make} />);
    await screen.findByRole("toolbar");
    const fake = p.made.last as NonNullable<typeof p.made.last>;
    act(() => fake.connect());
    expect(fake.connects).toBe(1);
    const frame = JSON.stringify({ type: "error", code: "doc_too_large" });
    act(() => fake.frame(frame));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This doc is at its size limit for your plan.",
    );
    await waitFor(() =>
      expect(
        document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
      ).toBe("false"),
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    // The provider reconnects to resync: a disconnect, then a connect.
    await waitFor(() => expect(fake.connects).toBe(2));
    expect(fake.disconnects).toBe(1);
    // A second frame does not start a reconnect loop.
    act(() => fake.frame(frame));
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.connects).toBe(2);
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
    expect(agent.querySelector(".oa-doc-flag-mark")).not.toBeNull();
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
