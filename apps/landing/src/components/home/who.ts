// "The right person decides": the who-line and the footer of an ask on a team,
// shared by the phone piece and the desktop stage. Fixed strings only.
const P = (l: string, c?: string) =>
  `<span class="pp sm${c ? ` ${c}` : ""}">${l}</span>`;

/** Who decides and who weighs in. `passed`: you passed it on to Sam. */
export function whoHtml(passed: boolean): string {
  return passed
    ? `<div class="wl">${P("S")}<span><b>Sam decides</b> (passed on by you)</span></div><div class="wl">${P("M")}${P("P")}You and Priya weigh in</div>`
    : `<div class="wl">${P("M", "you")}<b>You decide</b></div><div class="wl">${P("S")}${P("P")}Sam and Priya weigh in</div>`;
}

/** The footer: Decide / Not mine to decide, or what happened, with Undo. */
export function footHtml(
  passed: boolean,
  decided: boolean,
  sel: string | null,
): string {
  if (decided)
    return `<span class="st">You decided ${sel ? sel.toUpperCase() : ""} · just now</span><button type="button" class="alink" data-undo>Undo</button>`;
  if (passed)
    return `<span class="st">Passed to Sam · just now</span><button type="button" class="alink" data-undo>Undo</button>`;
  return `<button type="button" class="abtn" data-decide>Decide</button><button type="button" class="alink" data-pass>Not mine to decide</button>`;
}
