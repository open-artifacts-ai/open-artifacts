// The pinned scroll scene in the hero. Scroll moves it through four moments, then
// the turn, and back again. It only pins on a wide screen with motion allowed;
// otherwise the four moments stay stacked as cards, as the page renders them.
import { SCENE_CAPTIONS } from "../../lib/scene";
import { mountScene } from "./sceneview";

export function initScene(lp: HTMLElement, reduce: boolean) {
  const sc = lp.querySelector<HTMLElement>("#sc");
  if (!sc) return;
  if (reduce) {
    // No pinning and no hand-over: the story below reads as it is rendered.
    lp.setAttribute("data-cards", "");
    lp.dataset.hand = "1";
    return;
  }
  const pin = sc.querySelector<HTMLElement>("#scpin") as HTMLElement;
  const steps = sc.querySelector<HTMLElement>("#scsteps") as HTMLElement;
  const view = sc.querySelector<HTMLElement>("#scview") as HTMLElement;
  const caps = sc.querySelector<HTMLElement>("#sccaps") as HTMLElement;
  const dots = [
    ...(sc.querySelector<HTMLElement>("#scdots") as HTMLElement).children,
  ];
  const { set, land } = mountScene(view);
  sc.classList.add("pinned");

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
  // One story: when this pinned run ends, the stage below takes over in the
  // same place, at its last step (data-hand). Off a wide screen it does not apply.
  function hand() {
    const wide = lp.clientWidth > 820;
    const ended = wide
      ? steps.getBoundingClientRect().bottom -
          pin.getBoundingClientRect().bottom <=
        0.5
      : true;
    const v = ended ? "1" : "0";
    if (lp.dataset.hand !== v) lp.dataset.hand = v;
  }
  // The chapter rail sits under the stage; the hand-over leaves room for it.
  function setRh() {
    const rail = document.getElementById("rail");
    if (rail?.offsetHeight)
      lp.style.setProperty("--rh", `${12 + rail.offsetHeight}px`);
  }
  function render(force = false) {
    hand();
    if (lp.clientWidth <= 820) return;
    const { t, done } = read();
    sc?.classList.toggle("done", done);
    if (t === T && !force) return;
    T = t;
    const turn = t >= 50;
    sc?.classList.toggle("turn", turn);
    set(turn ? 49 : t);
    const s = Math.min(4, Math.floor(t / 10));
    if (s === 4) land();
    if (s !== capS) {
      capS = s;
      const p = document.createElement("p");
      const b = document.createElement("b");
      b.textContent = SCENE_CAPTIONS[s][0];
      p.append(b, SCENE_CAPTIONS[s][1]);
      caps.replaceChildren(p);
      // Four dashes for the hero's four moments; the 11-mark rail is the
      // story's, after the hand-over.
      dots.forEach((d, i) => {
        d.classList.toggle("on", i < s);
      });
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
  addEventListener("resize", () => {
    setRh();
    render(true);
  });
  setRh();
  render(true);
  addEventListener("load", setRh);
  document.fonts?.ready.then(setRh);
}
