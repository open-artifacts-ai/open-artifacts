// Phones: the whole story in one locked screen. Native scroll only, no scroll
// hijacking: a sticky screen stays put while a tall run of empty steps scrolls
// past, and the screen reads its state from how far the run has moved. Beats
// 0 to 3 are the four moments, 4 is the turn, 5 to 9 are the chapters, whose
// "try it" pieces move into the screen while it is locked and back when it is
// not. With reduced motion, or on a wide screen, nothing locks and the page
// stays as the cards it renders.
import { marksHtml, SCENE_CAPTIONS, SCENE_TURN } from "../../lib/scene";
import { mountScene } from "./sceneview";

export function initPhoneLock(lp: HTMLElement, reduce: boolean) {
  const found = lp.querySelector<HTMLElement>("#pl");
  if (!found || reduce) return;
  const pl: HTMLElement = found;
  const head = pl.querySelector<HTMLElement>("#plhead") as HTMLElement;
  const steps = pl.querySelector<HTMLElement>("#plsteps") as HTMLElement;
  const chap = pl.querySelector<HTMLElement>("#plchap") as HTMLElement;
  const view = pl.querySelector<HTMLElement>("#plview") as HTMLElement;
  const scene = mountScene(view);
  const chs = [...lp.querySelectorAll<HTMLElement>(".chs .ch")];
  const slots = chs.map(() => {
    const d = document.createElement("div");
    d.className = "pl-slot ch";
    chap.append(d);
    return d;
  });

  let on: boolean | null = null;
  let B = -1;
  let T = -1;

  // The locked screen is on for a narrow page. The chapters' pieces go with it.
  function mode() {
    const want = lp.clientWidth <= 820;
    if (want === on) return;
    on = want;
    lp.dataset.pl = want ? "1" : "0";
    chs.forEach((c, i) => {
      const ci = c.querySelector<HTMLElement>(".ci") as HTMLElement;
      const from = want ? ci : slots[i];
      const to = want ? slots[i] : ci;
      for (const e of [...from.children])
        if (e.classList.contains("try") || e.classList.contains("mp"))
          to.append(e);
    });
    B = -1;
    T = -1;
  }

  function render(force = false) {
    mode();
    if (!on) return;
    const unit = (steps.firstElementChild as HTMLElement).offsetHeight || 1;
    const p = Math.max(
      0,
      Math.min(9.999, -pl.getBoundingClientRect().top / unit),
    );
    const beat = Math.floor(p);
    const sub = Math.floor((p - beat) * 4);
    const t = beat < 4 ? (beat + 1) * 10 + sub : 49;
    if (beat !== B || force) {
      B = beat;
      pl.dataset.beat = String(beat);
      pl.classList.toggle("chap", beat >= 5);
      let title: string;
      let cap: string;
      if (beat < 4) {
        [title, cap] = SCENE_CAPTIONS[beat + 1] as [string, string];
      } else if (beat === 4) {
        [title, cap] = SCENE_TURN;
      } else {
        const c = chs[beat - 5] as HTMLElement;
        title = c.querySelector("h2")?.textContent ?? "";
        cap = c.querySelector(".ci > p")?.textContent ?? "";
      }
      head.innerHTML = `${marksHtml(beat < 4 ? beat + 1 : beat === 4 ? 4 : beat)}<b></b><p></p>`;
      (head.children[1] as HTMLElement).textContent = title;
      (head.children[2] as HTMLElement).textContent = cap;
      slots.forEach((s, i) => {
        s.classList.toggle("on", i === beat - 5);
      });
    }
    if (t !== T || force) {
      T = t;
      scene.set(t);
      if (t >= 40) scene.land();
    }
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
  render(true);
}
