// The pinned scroll scene in the hero. Scroll moves it through four moments, then
// the turn, and back again. It only pins on a wide screen with motion allowed;
// otherwise the four moments stay stacked as cards, as the page renders them.
import {
  marksHtml,
  SCENE_CAPTIONS,
  SCENE_STATES,
  sceneHtml,
} from "../../lib/scene";

export function initScene(lp: HTMLElement, reduce: boolean) {
  const sc = lp.querySelector<HTMLElement>("#sc");
  if (!sc || reduce) return;
  const pin = sc.querySelector<HTMLElement>("#scpin") as HTMLElement;
  const steps = sc.querySelector<HTMLElement>("#scsteps") as HTMLElement;
  const view = sc.querySelector<HTMLElement>("#scview") as HTMLElement;
  const caps = sc.querySelector<HTMLElement>("#sccaps") as HTMLElement;
  view.insertAdjacentHTML("beforeend", sceneHtml(10));
  const root = view.querySelector<HTMLElement>(".x-sides") as HTMLElement;
  sc.classList.add("pinned");

  const k = (n: string) =>
    root.querySelector<HTMLElement>(`[data-k="${n}"]`) as HTMLElement;
  function set(t: number) {
    const s = Math.max(1, Math.min(4, Math.floor(t / 10)));
    const S = SCENE_STATES[s] as NonNullable<(typeof SCENE_STATES)[number]>;
    root.dataset.s = String(s);
    for (const p of root.querySelectorAll<HTMLElement>(".sc-roll p"))
      p.classList.toggle("on", t >= Number(p.dataset.at));
    for (const e of root.querySelectorAll<HTMLElement>("[data-from]"))
      e.classList.toggle("off", s < Number(e.dataset.from));
    for (const e of root.querySelectorAll<HTMLElement>("[data-until]"))
      e.classList.toggle("off", s > Number(e.dataset.until));
    for (const e of root.querySelectorAll<HTMLElement>(".x-cm[data-at]"))
      e.classList.toggle("off", t < Number(e.dataset.at));
    k("ts").textContent = S.t;
    k("as").textContent = S.a;
    k("chip").textContent = S.chip;
    k("ch").textContent = S.ch;
    k("ask").innerHTML = S.ask;
    const v = k("ver");
    if (v.textContent !== S.ver) {
      const had = v.textContent;
      v.textContent = S.ver;
      if (had) {
        v.classList.remove("bump");
        void v.offsetWidth;
        v.classList.add("bump");
      }
    }
  }

  let T = -1;
  let capS = 0;
  function read() {
    const r = steps.getBoundingClientRect();
    const unit = (steps.firstElementChild as HTMLElement).offsetHeight || 1;
    const p = (pin.getBoundingClientRect().bottom - r.top) / unit;
    const q = Math.max(0, Math.min(4.999, p + 0.35));
    const step = Math.floor(q) + 1;
    const sub = Math.floor((q - Math.floor(q)) * 4);
    return { t: step * 10 + sub, done: p >= 3.25 };
  }
  function render(force = false) {
    if (lp.clientWidth <= 820) return;
    const { t, done } = read();
    sc?.classList.toggle("done", done);
    if (t === T && !force) return;
    T = t;
    const turn = t >= 50;
    sc?.classList.toggle("turn", turn);
    set(turn ? 49 : t);
    const s = Math.min(4, Math.floor(t / 10));
    if (s === 4) {
      // The last moment lands the transcript on the decision line.
      const roll = view.querySelector<HTMLElement>(".sc-roll") as HTMLElement;
      const clip = roll.parentElement as HTMLElement;
      const dec = roll.querySelector<HTMLElement>("p.dec") as HTMLElement;
      const y =
        clip.clientHeight -
        roll.offsetHeight +
        (dec.getBoundingClientRect().top - roll.getBoundingClientRect().top) +
        dec.offsetHeight / 2;
      roll.style.setProperty(
        "--land",
        `${Math.max(0, Math.round(clip.clientHeight / 2 - y))}px`,
      );
    }
    if (s !== capS) {
      capS = s;
      const p = document.createElement("p");
      const b = document.createElement("b");
      b.textContent = SCENE_CAPTIONS[s][0];
      p.append(b, SCENE_CAPTIONS[s][1]);
      p.insertAdjacentHTML("afterbegin", marksHtml(s));
      caps.replaceChildren(p);
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
