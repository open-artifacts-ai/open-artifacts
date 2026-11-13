// One live copy of the hero scene (a transcript beside an artifact) that a
// moment number drives. The wide pinned scene and the locked phone scene both
// use it. A moment is step * 10 + progress, as in lib/scene.ts.
import { SCENE_STATES, sceneHtml } from "../../lib/scene";

export function mountScene(host: HTMLElement) {
  host.insertAdjacentHTML("beforeend", sceneHtml(10));
  const root = host.querySelector<HTMLElement>(".x-sides") as HTMLElement;
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
    for (const e of root.querySelectorAll<HTMLElement>(".cm[data-at]"))
      e.classList.toggle("off", t < Number(e.dataset.at));
    k("ts").textContent = S.t;
    k("as").textContent = S.a;
    k("chip").textContent = S.chip;
    for (const e of root.querySelectorAll<HTMLElement>(".sa-blk"))
      e.classList.toggle("hit", s === 2);
    for (const e of root.querySelectorAll<HTMLElement>('[data-k="ld"]')) {
      e.classList.toggle("sel", s === 3);
      e.classList.toggle("chg", s === 4);
      e.classList.toggle("sw2", s >= 4);
    }
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

  // The last moment lands the transcript on the decision line.
  function land() {
    const roll = host.querySelector<HTMLElement>(".sc-roll") as HTMLElement;
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

  return { set, land };
}
