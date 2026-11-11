// Phones: nothing pins. Each chapter is its own card with only its piece of the
// artifact; the piece plays once when it scrolls into view, then takes taps.
// With reduced motion every piece lands at once.

export function initPhone(lp: HTMLElement, reduce: boolean) {
  const $ = <T extends HTMLElement = HTMLElement>(
    s: string,
    r: ParentNode = lp,
  ) => r.querySelector<T>(s) as T;
  const $$ = <T extends HTMLElement = HTMLElement>(
    s: string,
    r: ParentNode = lp,
  ) => [...r.querySelectorAll<T>(s)];
  const mp = (k: string) => $(`.mp[data-mp="${k}"]`);
  const bump = (el: HTMLElement, v: string) => {
    if (el.textContent === v) return;
    el.textContent = v;
    if (reduce) return;
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  };

  /* decide */
  const askCard = mp("ask");
  const options = $$(".mopt", askCard);
  for (const o of options)
    o.addEventListener("click", () => {
      const k = o.dataset.k;
      const name = k === "a" ? "Hacker News post" : "Email list";
      for (const x of options) x.setAttribute("aria-pressed", String(x === o));
      $(".why", askCard).classList.add("hide");
      const picked = $(".picked", askCard);
      picked.classList.remove("hide");
      const who = document.createElement("span");
      who.className = "pp you";
      who.textContent = "You";
      picked.replaceChildren(who, `You picked ${name}`);
      const done = $("[data-done]", askCard);
      done.classList.remove("on");
      $(".x", done).textContent =
        `Done. The plan now says the ${k === "a" ? "Hacker News post" : "email list"} goes first. That's v3.`;
      const show = () => {
        done.hidden = false;
        done.classList.add("on");
      };
      if (reduce) show();
      else setTimeout(show, 500);
    });

  /* live checklist */
  const live = mp("live");
  const items = $$(".cl li", live);
  const touchedItems: Record<number, boolean> = {};
  const count = () => {
    const n = items.filter((l) => l.classList.contains("ck")).length;
    $("[data-cnt]", live).textContent = `${n} of 5`;
    $("[data-bar]", live).style.width = `${n * 20}%`;
  };
  items.forEach((li, i) => {
    const b = $("button", li);
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      touchedItems[i] = true;
      const on = !li.classList.contains("ck");
      li.classList.toggle("ck", on);
      b.setAttribute("aria-pressed", String(on));
      if (on) {
        const who = document.createElement("span");
        who.className = "pp you";
        who.textContent = "You";
        $(".who", li).replaceChildren(who);
      }
      count();
    });
  });

  /* versions */
  const ver = mp("ver");
  const list = $(".vlist", ver);
  let top = 3;
  let cur = 3;
  const view = (v: number) => {
    cur = v;
    for (const b of $$("button", list))
      b.setAttribute("aria-pressed", String(Number(b.dataset.v) === v));
    $("[data-ban]", ver).classList.toggle("on", v !== top);
    $("[data-vb]", ver).textContent = `v${v}`;
    $("[data-ver]", ver).textContent = `v${v}`;
    $("[data-note]", ver).classList.add("hide");
  };
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-v]");
    if (b) view(Number(b.dataset.v));
  });
  $("[data-restore]", ver).addEventListener("click", () => {
    const from = cur;
    top++;
    for (const e of $$("em", list)) e.textContent = "";
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.v = String(top);
    b.setAttribute("aria-pressed", "true");
    const tag = document.createElement("b");
    tag.textContent = `v${top}`;
    const what = document.createElement("span");
    what.append(`Restored from v${from}`);
    const small = document.createElement("small");
    small.textContent = "You, just now";
    what.append(small);
    const em = document.createElement("em");
    em.textContent = "Current";
    b.append(tag, what, em);
    li.append(b);
    list.prepend(li);
    view(top);
    bump($("[data-ver]", ver), `v${top}`);
    const note = $("[data-note]", ver);
    note.textContent = `Restored as v${top}. Every earlier version is still here.`;
    note.classList.remove("hide");
    b.focus({ preventScroll: true });
  });

  /* share */
  const share = mp("share");
  const sw = $("[data-sw]", share);
  let swTouched = false;
  const link = (on: boolean) => {
    sw.setAttribute("aria-checked", String(on));
    $(".tog", sw).classList.toggle("on", on);
    $("[data-link]", share).classList.toggle("on", on);
    const v = $("[data-vis]", share);
    v.textContent = on ? "Public link" : "Private";
    v.classList.toggle("pub", on);
  };
  sw.addEventListener("click", () => {
    swTouched = true;
    link(sw.getAttribute("aria-checked") !== "true");
  });

  /* play once when it scrolls into view */
  const steps: Record<string, (m: HTMLElement, k: number) => void> = {
    com: (m, k) => {
      if (k !== 3) return;
      const l = $("[data-ln]", m);
      l.classList.remove("sel");
      l.classList.add("sw", "chg");
      bump($("[data-ver]", m), "v2");
    },
    live: (_m, k) => {
      const i = k - 1;
      if (touchedItems[i]) return;
      items[i].classList.add("ck");
      $("button", items[i]).setAttribute("aria-pressed", "true");
      count();
    },
    share: (_m, k) => {
      if (k === 2 && !swTouched) link(true);
    },
  };
  const COUNT: Record<string, number> = { pub: 2, com: 3, live: 4, share: 2 };
  const GAP: Record<string, number> = { com: 800, live: 550, share: 700 };
  const play = (m: HTMLElement) => {
    if (m.dataset.done) return;
    m.dataset.done = "1";
    const k = m.dataset.mp as string;
    for (let i = 1; i <= (COUNT[k] ?? 0); i++) {
      const f = () => {
        for (const e of $$(`[data-s="${i}"]`, m)) e.classList.add("on");
        steps[k]?.(m, i);
      };
      if (reduce) f();
      else setTimeout(f, i * (GAP[k] ?? 650));
    }
  };
  const all = $$(".mp");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es)
          if (e.isIntersecting) {
            play(e.target as HTMLElement);
            io.unobserve(e.target);
          }
      },
      { threshold: 0.3 },
    );
    for (const m of all) io.observe(m);
  } else for (const m of all) play(m);
}
