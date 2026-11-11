import { docSchema, yXmlFragmentToDoc } from "@oa/doc-schema";
import { TooltipProvider } from "@oa/ui/shadcn";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Editor, getSchema } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocEditor } from "../src/viewer/doc/DocEditor";
import {
  contentExtensions,
  LINK_REFUSED,
  toAllowedHref,
} from "../src/viewer/doc/extensions";
import { Toolbar } from "../src/viewer/doc/Toolbar";
import { fakeProviders } from "./doc-fake-provider";

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
      "Code",
      "Code block",
    ]);
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
    click("Code");
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
