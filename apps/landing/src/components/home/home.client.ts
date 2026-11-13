// Enhances the landing page. The HTML already shows every section in its
// landed state; this adds the hero scene, the story, the pricing
// toggle and the pause-when-off-screen rule. With reduced motion nothing
// plays or animates: states swap at once.
import { initPhone } from "./phone.client";
import { initPhoneLock } from "./phonelock.client";
import { initScene } from "./scene.client";
import { footHtml, whoHtml } from "./who";

const lp = document.getElementById("lp") as HTMLElement;
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  lp.querySelector<T>(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => [
  ...lp.querySelectorAll<T>(s),
];
const press = (el: HTMLElement, on: boolean) =>
  el.setAttribute("aria-pressed", String(on));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const narrow = () => lp.clientWidth <= 820;
lp.classList.add("lp-js");

/* ---- phone chapters ---- */
initPhone(lp, reduce);

/* ---- hero scene ---- */
initScene(lp, reduce);

/* ---- phone lock ---- */
initPhoneLock(lp, reduce);

/* ---- pricing ---- */
// A fade on the right edge says the table scrolls sideways, until the end.
{
  const tw = $("#twf .tw"),
    fade = $("#twf");
  const update = () =>
    fade.classList.toggle(
      "x-end",
      tw.scrollLeft + tw.clientWidth >= tw.scrollWidth - 4,
    );
  tw.addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();
}
for (const b of $$("#pricing .toggle button"))
  b.addEventListener("click", () => {
    const p = b.dataset.p as string;
    for (const x of $$("#pricing .toggle button")) press(x, x === b);
    for (const el of $$("#pricing [data-m]"))
      el.textContent = el.dataset[p] ?? "";
    requestAnimationFrame(alignPlans);
  });
// The plan buttons share one baseline: each header row is as tall as the
// tallest one, however a name, blurb or price wraps.
function alignPlans() {
  for (const c of [".pn", ".x-pd", ".amt"]) {
    const els = $$(`#pricing thead th ${c}`);
    for (const e of els) e.style.minHeight = "";
    const h = Math.max(0, ...els.map((e) => e.getBoundingClientRect().height));
    for (const e of els) e.style.minHeight = `${Math.ceil(h)}px`;
  }
}
alignPlans();
addEventListener("resize", alignPlans);
addEventListener("load", alignPlans);
document.fonts?.ready.then(alignPlans);

/* ---- scroll story ---- */
const stage = $("#stage"),
  chs = $$(".chs .ch"),
  rail = $$("#rail button"),
  ons = $$("[data-on]");
const ver = $("#ver"),
  ln = $("#ln"),
  chan = $("#chan"),
  track = $("#track"),
  clip = track.parentElement as HTMLElement;
const items = $$("#cl li"),
  opts = $$(".opt"),
  pollBtns = $$("#poll button");
let userVote: number | null = null;
// A tiny helper: the first matching element inside a parent.
const $in = (s: string, r: HTMLElement) => r.querySelector(s) as HTMLElement;
let userPick: string | null = null,
  passed = false,
  tSel: string | null = null,
  tDec = false,
  T = -1,
  lastVer = "";
const user: Record<number, boolean> = {};
const flag = (n: string, v: boolean) =>
  v ? stage.setAttribute(n, "") : stage.removeAttribute(n);
const line = () => innerHeight * 0.58;

// t = step * 10 + progress (0..3). The first chapter is step 2 (the scene above
// is steps 1 to 4 of nine, the chapters are 5 to 9), and the stage opens on the
// plan as the scene left it, so t never drops below 23. With reduced motion
// progress is fixed, so each chapter shows its landed still (the versions
// chapter shows the older version).
function read() {
  const y = line();
  let step = 1,
    p = 0;
  chs.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    if (r.top <= y) {
      step = i + 2;
      p = Math.min(0.999, (y - r.top) / r.height);
    }
  });
  // step here counts chapters: comment 2, ask 3, team 4, record 5, live 6,
  // versions 7, share 8.
  if (reduce) return Math.max(23, step * 10 + (step === 7 ? 1 : 3));
  return Math.max(23, step * 10 + Math.floor(p * 4));
}
function render(force = false) {
  // At 820px and under the stage is hidden and the chapters are cards.
  if (narrow()) return;
  const raw = read();
  if (raw === T && !force) return;
  T = raw;
  const ns = Math.floor(raw / 10);
  // The stage's own steps (ask 3, live 4, versions 5, share 6) drive the
  // existing logic; the team and record chapters hold the ask as it was.
  const step = ns <= 3 ? ns : ns <= 5 ? 3 : ns - 2;
  const t = ns <= 3 ? raw : ns <= 5 ? 39 : step * 10 + (raw % 10);
  const teamV = ns === 4;
  stage.dataset.step = String(step);
  flag("data-team", teamV);
  flag("data-dec", ns === 5);
  for (const e of ons) e.classList.toggle("on", t >= Number(e.dataset.on));
  // The poll and checklist are out of reach until they have appeared.
  for (const id of ["#poll", "#cl"])
    ($(id) as HTMLElement & { inert: boolean }).inert =
      !$(id).classList.contains("on");
  chs.forEach((c, i) => {
    c.classList.toggle("cur", i + 2 === ns || (ns <= 1 && i === 0));
  });
  rail.forEach((b, i) => {
    b.classList.toggle("done", i + 2 < ns);
    if (i + 2 === ns) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  });
  flag("data-past1", step >= 2);
  flag("data-side", step === 2 || step === 3);
  flag("data-fan", step === 5);
  ln.classList.toggle("sel", t >= 20 && t < 23);
  ln.classList.toggle("sw", t >= 23);
  ln.classList.toggle("chg", t >= 23 && t < 30);
  const pick = userPick || (t >= 32 ? "b" : null);
  const done = !!pick && (!!userPick || t >= 33) && t >= 30;
  // The team chapter shows the ask undecided, with its own pick and who decides.
  const vp = teamV ? null : pick;
  const vd = teamV ? false : done;
  $("#thread").classList.toggle("hide", t >= 30);
  $("#tcol").classList.toggle("hide", t < 30);
  $("#ask").classList.toggle("hide", t < 30);
  $("#sopen").textContent =
    t >= 30 ? (vd ? "All resolved" : "1 ask for you") : "1 open";
  for (const o of opts) press(o, o.dataset.k === (teamV ? tSel : vp));
  $("#ask").classList.toggle("need", !vp);
  $("#ask [data-askq]").classList.toggle("hide", !!vp);
  const name =
    pick === "a"
      ? "Hacker News post"
      : pick === "x"
        ? "Your answer"
        : "Email list";
  $("#why").classList.toggle("hide", !!vp);
  const picked = $("#picked");
  picked.classList.toggle("hide", !vp);
  picked.replaceChildren();
  if (vp) {
    const who = document.createElement("span");
    who.className = userPick ? "pp you" : "pp";
    who.textContent = userPick ? "You" : "SR";
    picked.append(
      who,
      userPick
        ? vp === "x"
          ? "You answered in your own words"
          : `You picked ${vp.toUpperCase()}`
        : `Sam Rivera picked ${vp.toUpperCase()}`,
    );
  }
  $("#adone").classList.toggle("on", vd);
  $("#adonex").textContent =
    pick === "x"
      ? "Done. The plan now follows your answer. That's v5."
      : `Done. The plan now says the ${pick === "a" ? "Hacker News post" : "email list"} goes first. That's v5.`;
  if (teamV) {
    $("#whol").innerHTML = whoHtml(passed);
    $("#tmf").innerHTML = footHtml(passed, tDec, tSel);
  }
  $("#chanv").textContent = name;
  const viewOld = t >= 51 && t < 53;
  chan.classList.toggle("on", done && !viewOld);
  chan.classList.toggle("chg", done && t < 40);
  $("#vban").classList.toggle("on", viewOld);
  const v = viewOld ? "v4" : done ? "v5" : t >= 23 ? "v4" : "v3";
  if (v !== lastVer) {
    ver.textContent = v;
    if (lastVer && !reduce) {
      ver.classList.remove("bump");
      void ver.offsetWidth;
      ver.classList.add("bump");
    }
    lastVer = v;
  }
  let n = 0;
  items.forEach((li, i) => {
    const auto = i < 4 && t >= 40 + i,
      on = i in user ? user[i] : auto;
    li.classList.toggle("ck", on);
    li.querySelector("button")?.setAttribute("aria-pressed", String(on));
    if (on) n++;
    const who = li.querySelector(".who") as HTMLElement;
    if (i in user && user[i]) who.innerHTML = '<span class="pp you">You</span>';
  });
  $("#cnt").textContent = `${n} of 5`;
  ($("#cbar") as HTMLElement).style.width = `${n * 20}%`;
  // The poll: four votes arrive as the chapter plays, then the reader's own
  // click toggles one more.
  const votes = [0, 0, 0];
  [1, 0, 1, 1].forEach((day, i) => {
    if (t >= 40 + i) votes[day]++;
  });
  if (userVote !== null) votes[userVote]++;
  const total = votes[0] + votes[1] + votes[2];
  pollBtns.forEach((b, i) => {
    $in("b", b).textContent = String(votes[i]);
    $in("i", b).style.width = `${total ? (votes[i] / total) * 100 : 0}%`;
    press(b, userVote === i);
  });
  $("#pcnt").textContent = `${total} ${total === 1 ? "vote" : "votes"}`;
  const need = Math.max(
    0,
    Math.min($("#plh").offsetTop - 10, track.scrollHeight - clip.clientHeight),
  );
  track.style.transform = step === 4 ? `translateY(-${need}px)` : "";
  $("#pop").classList.toggle("on", step === 6);
  $("#tog").classList.toggle("on", t >= 62);
  const pub = t >= 62,
    vis = $("#vis");
  vis.textContent = pub ? "Public link" : "Shared with 4";
  vis.classList.toggle("pub", pub);
}
let raf = 0;
const tick = () => {
  if (!raf)
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
};
addEventListener("scroll", tick, { passive: true });
addEventListener("resize", () => render(true));
for (const o of opts)
  o.addEventListener("click", () => {
    if (stage.hasAttribute("data-team")) {
      tSel = o.dataset.k as string;
      tDec = false;
    } else userPick = o.dataset.k as string;
    render(true);
  });
$("#ask").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const note = $("#ask .anote");
  if (t.closest("[data-pass]")) {
    passed = true;
    render(true);
  } else if (t.closest("[data-undo]")) {
    passed = false;
    tDec = false;
    render(true);
  } else if (t.closest("[data-decide]")) {
    if (tSel) {
      tDec = true;
      render(true);
    }
  } else if (t.closest("[data-next]") || t.closest("[data-askq]")) {
    note.textContent = t.closest("[data-next]")
      ? "In the product, this jumps to your next open ask."
      : "In the product, this opens a question to the agent that asked.";
    note.classList.remove("hide");
  }
});
pollBtns.forEach((b, i) => {
  b.addEventListener("click", () => {
    userVote = userVote === i ? null : i;
    render(true);
  });
});
items.forEach((li, i) => {
  (li.querySelector("button") as HTMLElement).addEventListener("click", () => {
    user[i] = !li.classList.contains("ck");
    render(true);
  });
});
rail.forEach((b, i) => {
  b.addEventListener("click", () => {
    const r = chs[i].getBoundingClientRect();
    scrollTo({ top: scrollY + r.top - line() + r.height * 0.8 });
  });
});
render(true);

/* ---- pause the animations when their section is off screen ---- */
if ("IntersectionObserver" in window) {
  const seen = new Set<Element>();
  const targets = ["header.hero", ".sc", "#story", "#pl"]
    .map((s) => lp.querySelector(s))
    .filter((e): e is Element => !!e);
  const io = new IntersectionObserver((es) => {
    for (const e of es)
      if (e.isIntersecting) seen.add(e.target);
      else seen.delete(e.target);
    if (seen.size) lp.removeAttribute("data-offscreen");
    else lp.setAttribute("data-offscreen", "");
  });
  for (const t of targets) io.observe(t);
}
