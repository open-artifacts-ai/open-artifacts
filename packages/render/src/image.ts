import { unpreviewableHtml } from "./code";

/**
 * The image view: one <img> of the entry, centered and fit to the frame. Only
 * ever <img>: an SVG is never inlined or framed, so its scripts never run (the
 * bytes also come with a sandbox CSP). Resolves once the image has decoded or
 * failed; a failure shows the not-shown note with Download.
 */
export function renderImage(
  url: string,
  name: string,
  root: HTMLElement,
): Promise<void> {
  const box = document.createElement("div");
  box.className = "oa-image";
  const img = document.createElement("img");
  img.alt = name;
  img.decoding = "async";
  box.append(img);
  root.replaceChildren(box);
  return new Promise((resolve) => {
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener(
      "error",
      () => {
        root.innerHTML = unpreviewableHtml("binary", url, name);
        resolve();
      },
      { once: true },
    );
    img.src = url;
  });
}
