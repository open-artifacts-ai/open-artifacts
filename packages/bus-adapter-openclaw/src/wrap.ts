const attr = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** A body can neither close the wrapper nor open a second one with a forged sender. */
export const neutralize = (s: string): string =>
  s.replace(/<(\s*\/?\s*cross-session-message)/gi, "&lt;$1");

/**
 * `text` inside the `<cross-session-message>` wrapper Claude Code gets
 * (bus-adapter-claude-code/src/inject.ts) and Hermes gets (wrap.py): the
 * sender is the bus's own word for it.
 */
export function wrap(
  fromName: string,
  text: string,
  source = "oa-bus",
): string {
  return (
    `<cross-session-message from="${attr(source)}" from-name="${attr(fromName)}" from-mode="prompting">\n` +
    `${neutralize(text)}\n</cross-session-message>`
  );
}
