// Enhances the landing page. The HTML already shows every section in its
// landed state; this adds the question chips, the scroll story, the pricing
// toggle and the pause-when-off-screen rule. With reduced motion nothing
// plays or animates: states swap at once.
import {
  ARTIFACT_STATUS,
  type Look,
  lines,
  type Question,
  transcriptStatus,
} from "../../lib/transcript";
import { initPhone } from "./phone.client";

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

/* ---- before and after ---- */
const ba = $("#ba"),
  term = $("#term"),
  trs = $("#trs"),
  trstat = $("#trstat"),
  arstat = $("#arstat");
let look: Look = "claude";
let run = 0,
  cur: Question | "" = "dec",
  touched = false;

function draw(l: Look) {
  look = l;
  term.dataset.look = l;
  $("#tname").textContent = l;
  const none = trs.querySelector(".none") as HTMLElement;
  trs.replaceChildren(none);
  for (const ln of lines(l)) {
    const p = document.createElement("p");
    if (ln.cls) p.className = ln.cls;
    if (ln.tag) p.dataset.tag = ln.tag;
    p.textContent = ln.text;
    if (ln.sub) {
      const s = document.createElement("span");
      s.className = "sub";
      s.textContent = ln.sub;
      p.append(s);
    }
    trs.append(p);
  }
  for (const b of $$(".x-look button")) press(b, b.dataset.look === l);
}
function targetFor(q: Question) {
  if (q === "team") return 0;
  const el = trs.querySelector<HTMLElement>(
    `[data-tag=${q === "dec" ? "dec" : "chg"}]`,
  ) as HTMLElement;
  const max = trs.scrollHeight - trs.clientHeight;
  return Math.max(
    0,
    Math.min(
      max,
      el.offsetTop - trs.offsetTop - trs.clientHeight / 2 + el.offsetHeight / 2,
    ),
  );
}
function show(side: string) {
  ba.dataset.show = side;
  for (const b of $$(".x-flip button")) press(b, b.dataset.side === side);
  // Coming back to the transcript, the answer is where the last question left it.
  if (side === "tr" && cur && ba.hasAttribute("data-landed"))
    trs.scrollTop = targetFor(cur);
}
function land(q: Question) {
  const ps = $$("#trs p:not(.none)");
  for (const e of ps) e.classList.remove("hit");
  term.removeAttribute("data-none");
  if (q === "dec")
    ps.find((p) => p.dataset.tag === "dec")?.classList.add("hit");
  else if (q === "chg") {
    for (const p of ps) if (p.dataset.tag === "chg") p.classList.add("hit");
  } else term.setAttribute("data-none", "");
  trstat.textContent = transcriptStatus(q, lines(look));
}
function ask(q: Question) {
  const id = ++run;
  cur = q;
  ba.dataset.q = q;
  ba.removeAttribute("data-landed");
  for (const b of $$(".x-qs button")) press(b, b.dataset.q === q);
  for (const e of $$("#trs .hit")) e.classList.remove("hit");
  term.removeAttribute("data-none");
  for (const b of $$(".x-blk")) b.classList.toggle("hit", b.id === `b-${q}`);
  const blk = $(`#b-${q}`),
    body = blk.parentElement as HTMLElement;
  body.scrollTop = q === "dec" ? 0 : blk.offsetTop - body.offsetTop - 8;
  arstat.textContent = ARTIFACT_STATUS[q];
  const max = trs.scrollHeight - trs.clientHeight;
  const target = targetFor(q);
  const done = () => {
    if (id !== run) return;
    land(q);
    if (q === "team") trs.scrollTop = 0;
    // On a phone the "Now see it in an artifact" button shows once this lands.
    ba.setAttribute("data-landed", "");
  };
  // Reduced motion, or the transcript is on the hidden side: land at once.
  if (reduce || !trs.clientHeight) {
    trs.scrollTop = target;
    done();
    return;
  }
  trstat.textContent = "Scrolling back…";
  trs.scrollTop = max;
  const dur = q === "team" ? 2600 : q === "chg" ? 2200 : 1800,
    t0 = performance.now();
  (function step(now: number) {
    if (id !== run) return;
    const p = Math.min(1, (now - t0) / dur),
      e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    trs.scrollTop = max + (target - max) * e;
    if (p < 1) requestAnimationFrame(step);
    else done();
  })(t0);
}
for (const b of $$(".x-qs button"))
  b.addEventListener("click", () => {
    touched = true;
    ask(b.dataset.q as Question);
  });
for (const b of $$(".x-flip button"))
  b.addEventListener("click", () => {
    touched = true;
    show(b.dataset.side as string);
  });
$("#nudge").addEventListener("click", () => {
  touched = true;
  show("ar");
  $(".x-flip button[data-side=ar]").focus({ preventScroll: true });
});
for (const b of $$(".x-look button"))
  b.addEventListener("click", () => {
    touched = true;
    draw(b.dataset.look as Look);
    if (cur) ask(cur);
    else trs.scrollTop = trs.scrollHeight;
  });
// The first question plays once on load, unless the reader already picked one.
trs.scrollTop = trs.scrollHeight;
if (!reduce)
  setTimeout(() => {
    if (!touched) ask("dec");
  }, 900);
else {
  trs.scrollTop = 0;
  const hit = trs.querySelector<HTMLElement>(".hit");
  if (hit)
    trs.scrollTop = Math.max(
      0,
      hit.offsetTop - trs.offsetTop - trs.clientHeight / 2,
    );
}

/* ---- phone chapters ---- */
initPhone(lp, reduce);

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
  });

/* ---- scroll story ---- */
const stage = $("#stage"),
  chs = $$(".ch"),
  rail = $$("#rail button"),
  ons = $$("[data-on]");
const ver = $("#ver"),
  ln = $("#ln"),
  chan = $("#chan"),
  track = $("#track"),
  clip = track.parentElement as HTMLElement;
const items = $$("#cl li"),
  opts = $$(".opt");
let userPick: string | null = null,
  T = -1,
  lastVer = "";
const user: Record<number, boolean> = {};
const flag = (n: string, v: boolean) =>
  v ? stage.setAttribute(n, "") : stage.removeAttribute(n);
const line = () =>
  narrow() ? stage.getBoundingClientRect().height + 60 : innerHeight * 0.58;

// t = chapter * 10 + progress (0..3). With reduced motion progress is fixed, so
// each chapter shows its landed still (the versions chapter shows the old one).
function read() {
  const y = line();
  let step = 0,
    p = 0;
  chs.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    if (r.top <= y) {
      step = i + 1;
      p = Math.min(0.999, (y - r.top) / r.height);
    }
  });
  if (reduce) return step * 10 + (step === 5 ? 1 : 3);
  return step * 10 + Math.floor(p * 4);
}
function render(force = false) {
  const t = read();
  if (t === T && !force) return;
  T = t;
  const step = Math.floor(t / 10);
  stage.dataset.step = String(step);
  for (const e of ons) e.classList.toggle("on", t >= Number(e.dataset.on));
  chs.forEach((c, i) => {
    c.classList.toggle("cur", i + 1 === step || (step === 0 && i === 0));
  });
  rail.forEach((b, i) => {
    b.classList.toggle("done", i + 1 < step);
    if (i + 1 === step) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  });
  flag("data-past1", step >= 2);
  flag("data-side", step === 2 || step === 3);
  flag("data-fan", step === 5);
  flag("data-wall", step >= 7);
  ln.classList.toggle("sel", t >= 20 && t < 23);
  ln.classList.toggle("sw", t >= 23);
  ln.classList.toggle("chg", t >= 23 && t < 30);
  const pick = userPick || (t >= 32 ? "b" : null);
  const done = !!pick && (!!userPick || t >= 33) && t >= 30;
  $("#thread").classList.toggle("hide", t >= 30);
  $("#tcol").classList.toggle("hide", t < 30);
  $("#ask").classList.toggle("hide", t < 30);
  $("#sopen").textContent =
    t >= 30 ? (done ? "All resolved" : "1 ask for you") : "1 open";
  for (const o of opts) press(o, o.dataset.k === pick);
  const name = pick === "a" ? "Hacker News post" : "Email list";
  $("#why").classList.toggle("hide", !!pick);
  const picked = $("#picked");
  picked.classList.toggle("hide", !pick);
  picked.replaceChildren();
  if (pick) {
    const who = document.createElement("span");
    who.className = userPick ? "pp you" : "pp";
    who.textContent = userPick ? "You" : "SR";
    picked.append(who, `${userPick ? "You" : "Sam Rivera"} picked ${name}`);
  }
  $("#adone").classList.toggle("on", done);
  $("#adonex").textContent =
    `Done. The plan now says the ${pick === "a" ? "Hacker News post" : "email list"} goes first. That's v3.`;
  $("#chanv").textContent = name;
  const viewOld = t >= 51 && t < 53;
  chan.classList.toggle("on", done && !viewOld);
  chan.classList.toggle("chg", done && t < 40);
  $("#vban").classList.toggle("on", viewOld);
  const v = viewOld ? "v2" : done ? "v3" : t >= 23 ? "v2" : "v1";
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
    if (on) n++;
    const who = li.querySelector(".who") as HTMLElement;
    if (i in user && user[i]) who.innerHTML = '<span class="pp you">You</span>';
  });
  $("#cnt").textContent = `${n} of 5`;
  ($("#cbar") as HTMLElement).style.width = `${n * 20}%`;
  const need = Math.max(
    0,
    Math.min($("#clh").offsetTop - 10, track.scrollHeight - clip.clientHeight),
  );
  const lnTop = Math.max(0, ln.offsetTop - 10);
  track.style.transform =
    step === 4
      ? `translateY(-${need}px)`
      : narrow() && (step === 2 || step === 3)
        ? `translateY(-${lnTop}px)`
        : "";
  $("#pop").classList.toggle("on", step === 6);
  $("#tog").classList.toggle("on", t >= 62);
  const pub = t >= 62,
    vis = $("#vis");
  vis.textContent = pub ? "Public link" : "Private";
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
    userPick = o.dataset.k as string;
    render(true);
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
  const targets = [$(".x-busg"), $("#story"), $(".x-intro")];
  const io = new IntersectionObserver((es) => {
    for (const e of es)
      if (e.isIntersecting) seen.add(e.target);
      else seen.delete(e.target);
    if (seen.size) lp.removeAttribute("data-offscreen");
    else lp.setAttribute("data-offscreen", "");
  });
  for (const t of targets) io.observe(t);
}
