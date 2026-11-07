import { useEffect, useRef } from "react";

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const out = (value: number) => 1 - (1 - clamp(value)) ** 4;
const into = (value: number) => clamp(value) ** 3;
const interval = (t: number, a: number, b: number, curve = out) =>
  curve((t - a) / (b - a));

// Keep the original 1.216s lead-in; compress only the post-ring formation.
const MOTION_DURATION_MS = 2200;
const LEAD_DURATION_MS = 1216;
const LEAD_PROGRESS = 0.38;
const motionProgress = (elapsed: number) =>
  elapsed <= LEAD_DURATION_MS
    ? clamp(elapsed / 3200)
    : LEAD_PROGRESS +
      clamp(
        (elapsed - LEAD_DURATION_MS) / (MOTION_DURATION_MS - LEAD_DURATION_MS),
      ) *
        (1 - LEAD_PROGRESS);
const motionElapsed = (progress: number) =>
  progress <= LEAD_PROGRESS
    ? progress * 3200
    : LEAD_DURATION_MS +
      ((progress - LEAD_PROGRESS) / (1 - LEAD_PROGRESS)) *
        (MOTION_DURATION_MS - LEAD_DURATION_MS);

// Existing upstream frame and corners, with a proposed centered 12-unit core.
const FRAME_PARTS = [
  "M22 2H5a3 3 0 0 0-3 3v17l4 4V6h20z",
  "M10 30h17a3 3 0 0 0 3-3V10l-4-4v20H6z",
];
const ACCENT =
  "M22 2h5a3 3 0 0 1 3 3v5zM2 22v5a3 3 0 0 0 3 3h5zM12 10h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z";

type Point = readonly [number, number];
const STEPS = 192;
const smooth = (value: number) => {
  const x = clamp(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

// Underdamped scale response: ~12% overshoot at 126ms, then a small recoil.
// Quench only the tiny final oscillation so the completed SVG has no long tail.
function coreScale(t: number) {
  const elapsed = (motionElapsed(t) - motionElapsed(0.68)) / 1000;
  if (elapsed <= 0) return 0;
  if (elapsed >= 0.38) return 1;
  const dampingRatio = 0.56;
  const frequency = 30;
  const root = Math.sqrt(1 - dampingRatio * dampingRatio);
  const damped = frequency * root;
  const response =
    1 -
    Math.exp(-dampingRatio * frequency * elapsed) *
      (Math.cos(damped * elapsed) +
        (dampingRatio / root) * Math.sin(damped * elapsed));
  return lerp(response, 1, smooth((elapsed - 0.26) / 0.12));
}

// Each opaque band retains its outer edge, inner edge and connected end caps.
// The upper-left frame is sampled analytically; the other is its 180° rotation.
const targetOuter: Point[] = Array.from({ length: STEPS + 1 }, (_, i) => {
  const arc = (Math.PI * 3) / 2;
  const distance = (i / STEPS) * (34 + arc);
  let x: number;
  let y: number;
  if (distance <= 17) {
    x = 22 - distance;
    y = 2;
  } else if (distance <= 17 + arc) {
    const angle = -Math.PI / 2 - (distance - 17) / 3;
    x = 5 + 3 * Math.cos(angle);
    y = 5 + 3 * Math.sin(angle);
  } else {
    x = 2;
    y = 5 + distance - 17 - arc;
  }
  return [x * 8, y * 8];
});
const targetInner: Point[] = Array.from({ length: STEPS + 1 }, (_, i) => {
  const t = i / STEPS;
  return t <= 0.5 ? [48, (26 - t * 40) * 8] : [(6 + (t - 0.5) * 40) * 8, 48];
});
const accentShapes = new WeakMap<Path2D, Path2D[]>();
function splitAccent(path: Path2D) {
  let shapes = accentShapes.get(path);
  if (!shapes) {
    shapes = [
      new Path2D("M22 2h5a3 3 0 0 1 3 3v5z"),
      new Path2D("M2 22v5a3 3 0 0 0 3 3h5z"),
      new Path2D(
        "M12 10h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
      ),
    ];
    accentShapes.set(path, shapes);
  }
  return shapes;
}

/** Continuous ring bands straighten into the original frame, without an opacity swap. */
function formation(
  ctx: CanvasRenderingContext2D,
  t: number,
  frames: Path2D[],
  accentPath: Path2D,
  ink: string,
  accent: string,
) {
  ctx.fillStyle = ink;
  if (t >= 0.93) {
    ctx.save();
    ctx.scale(8, 8);
    frames.forEach((path) => {
      ctx.fill(path);
    });
    ctx.fillStyle = accent;
    ctx.fill(accentPath);
    ctx.restore();
    return;
  }
  if (t < 0.38) {
    let radius: number;
    let inner = 0;
    if (t < 0.09) radius = lerp(0, 7, interval(t, 0, 0.06));
    else if (t < 0.14) radius = lerp(7, 4, interval(t, 0.09, 0.14, into));
    else {
      const expansion = interval(t, 0.14, 0.31);
      radius = lerp(4, 80, expansion);
      inner = lerp(0, 54, expansion);
    }
    ctx.beginPath();
    ctx.arc(128, 128, radius, 0, Math.PI * 2);
    if (inner > 0) ctx.arc(128, 128, inner, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    return;
  }

  for (let part = 0; part < 2; part++) {
    const progress = interval(
      t,
      0.38 + part * 0.025,
      0.81 + part * 0.025,
      smooth,
    );
    const opening = Math.sin(progress * Math.PI) * 4;
    const direction = part ? 1 : -1;
    ctx.save();
    ctx.translate(128 + direction * opening, 128 + direction * opening);
    ctx.rotate(part * Math.PI);
    ctx.translate(-128, -128);
    ctx.beginPath();
    for (let edge = 0; edge < 2; edge++) {
      const targets = edge ? targetInner : targetOuter;
      for (let i = 0; i <= STEPS; i++) {
        const phase = i / STEPS;
        const angle = edge
          ? -Math.PI * 1.25 + phase * Math.PI
          : -Math.PI / 4 - phase * Math.PI;
        const radius = edge ? 54 : 80;
        const x = lerp(128 + radius * Math.cos(angle), targets[i][0], progress);
        const y = lerp(128 + radius * Math.sin(angle), targets[i][1], progress);
        if (!edge && !i) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const [topCorner, , core] = splitAccent(accentPath);
  ctx.save();
  ctx.scale(8, 8);
  ctx.fillStyle = accent;
  for (let part = 0; part < 2; part++) {
    const reveal = interval(t, 0.66 + part * 0.03, 0.82 + part * 0.03, smooth);
    if (reveal <= 0) continue;
    const limit = lerp(20, 32, reveal);
    ctx.save();
    if (part) {
      ctx.translate(32, 32);
      ctx.rotate(Math.PI);
    }
    // Reveal from the frame's diagonal joining edge toward the outer corner.
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(limit, 0);
    ctx.lineTo(32, 32 - limit);
    ctx.lineTo(32, 32);
    ctx.lineTo(0, 32);
    ctx.closePath();
    ctx.clip();
    ctx.fill(topCorner);
    ctx.restore();
  }
  const center = coreScale(t);
  if (center > 0) {
    ctx.save();
    ctx.translate(16, 16);
    ctx.scale(center, center);
    ctx.translate(-16, -16);
    ctx.fill(core);
    ctx.restore();
  }
  ctx.restore();
}

/** Decorative brand motion. Authentication never waits for its completion. */
export function MarkFormation() {
  const visualRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const visual = visualRef.current;
    const svg = svgRef.current;
    const canvas = canvasRef.current;
    if (!visual || !svg || !canvas || typeof matchMedia !== "function") return;
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof Path2D !== "function") return;
    const framePaths = FRAME_PARTS.map((path) => new Path2D(path));
    const accentPath = new Path2D(ACCENT);
    const accentElement = svg.querySelector("[data-formation-accent]");
    if (!accentElement) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let startTime = 0;
    let progress = 1;
    let playing = false;
    let disposed = false;

    const complete = () => {
      cancelAnimationFrame(frame);
      playing = false;
      progress = 1;
      canvas.hidden = true;
      svg.style.visibility = "visible";
    };
    const draw = () => {
      const width = visual.getBoundingClientRect().width;
      if (!width) return false;
      const size = Math.max(
        1,
        Math.round(width * Math.min(devicePixelRatio || 1, 2)),
      );
      if (canvas.width !== size || canvas.height !== size) {
        canvas.width = size;
        canvas.height = size;
      }
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.scale(size / 256, size / 256);
      formation(
        ctx,
        progress,
        framePaths,
        accentPath,
        getComputedStyle(visual).color,
        getComputedStyle(accentElement).fill,
      );
      ctx.restore();
      return true;
    };
    const tick = (now: number) => {
      if (disposed || !playing) return;
      progress = motionProgress(now - startTime);
      if (progress >= 1 || document.hidden || reduced.matches) {
        complete();
        return;
      }
      if (draw()) {
        canvas.hidden = false;
        svg.style.visibility = "hidden";
      }
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      complete();
      if (disposed || reduced.matches || document.hidden) return;
      playing = true;
      progress = 0;
      startTime = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const onPreference = () => {
      if (reduced.matches) complete();
    };
    const onVisibility = () => {
      if (document.hidden) complete();
    };
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (playing) draw();
          })
        : null;
    observer?.observe(visual);
    reduced.addEventListener("change", onPreference);
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      disposed = true;
      complete();
      observer?.disconnect();
      reduced.removeEventListener("change", onPreference);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="oa-formation">
      <div
        ref={visualRef}
        aria-hidden="true"
        style={{ position: "relative", width: "100%", aspectRatio: "1" }}
      >
        <svg
          ref={svgRef}
          aria-hidden="true"
          viewBox="0 0 32 32"
          fill="currentColor"
          focusable="false"
          style={{ display: "block", width: "100%", height: "100%" }}
        >
          <path d={FRAME_PARTS.join("")} />
          <path
            data-formation-accent=""
            style={{
              fill: "var(--oa-brand-accent, var(--oa-accent, #2350D0))",
            }}
            d={ACCENT}
          />
        </svg>
        <canvas
          ref={canvasRef}
          hidden
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
        />
      </div>
    </div>
  );
}
