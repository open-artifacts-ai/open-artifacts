/**
 * The landing's agent badges (#2471): the product's own agent tile, an
 * animal in a rounded square filled with its presence colour. Fox and owl
 * are copied from DRAWN in apps/dashboard/src/viewer/presence/animals.tsx;
 * turtle, rabbit and squirrel from lucide 1.59.0 (the dashboard's pin).
 */
export const ANIMALS = {
  fox: '<path d="M3 3.5l5.5 3.7h7L21 3.5V11c0 4.5-4.5 10-9 10S3 15.5 3 11z"/><path d="M8 11.5h.01M16 11.5h.01"/><path d="M10.5 17h3L12 18.8z"/>',
  owl: '<path d="M5 9.5V4l3.5 2.5h7L19 4v5.5c0 6-3 10.5-7 10.5s-7-4.5-7-10.5z"/><circle cx="9" cy="10" r="2.2"/><circle cx="15" cy="10" r="2.2"/><path d="m11 13.7 1 1.8 1-1.8"/><path d="M9.5 20.5v1.5M14.5 20.5v1.5"/>',
  turtle:
    '<path d="m12 10 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a8 8 0 1 0-16 0v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3l2-4h4Z"/><path d="M4.82 7.9 8 10"/><path d="M15.18 7.9 12 10"/><path d="M16.93 10H20a2 2 0 0 1 0 4H2"/>',
  rabbit:
    '<path d="M13 16a3 3 0 0 1 2.24 5"/><path d="M18 12h.01"/><path d="M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3"/><path d="M20 8.54V4a2 2 0 1 0-4 0v3"/><path d="M7.612 12.524a3 3 0 1 0-1.6 4.3"/>',
  squirrel:
    '<path d="M15.236 22a3 3 0 0 0-2.2-5"/><path d="M16 20a3 3 0 0 1 3-3h1a2 2 0 0 0 2-2v-2a4 4 0 0 0-4-4V4"/><path d="M18 13h.01"/><path d="M18 6a4 4 0 0 0-4 4 7 7 0 0 0-7 7c0-5 4-5 4-10.5a4.5 4.5 0 1 0-9 0 2.5 2.5 0 0 0 5 0C7 10 3 11 3 17c0 2.8 2.2 5 5 5h10"/>',
} as const;

export type Animal = keyof typeof ANIMALS;

/** The product's presence colours (--oa-presence-N), one set for light and dark. */
export const PRESENCE = [
  "#0e6e8c",
  "#1f6f5a",
  "#2456c4",
  "#4d6b12",
  "#5b48b8",
  "#7a3f99",
  "#8a4d0f",
  "#a3305f",
  "#b04a14",
] as const;

/** Each agent on the page keeps one animal and colour everywhere. */
export const AGENTS = {
  "OA Product": { animal: "fox", color: 2 },
  "OA Docs": { animal: "owl", color: 5 },
  Backend: { animal: "turtle", color: 1 },
  Reviewer: { animal: "rabbit", color: 7 },
  Release: { animal: "squirrel", color: 8 },
} as const satisfies Record<string, { animal: Animal; color: number }>;

export function agentSvg(animal: Animal): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ANIMALS[animal]}</svg>`;
}

/** The badge as a string, for scene.ts. `extra` is added to the class list. */
export function agentBadge(
  animal: Animal,
  color: number,
  extra = "",
  attrs = "",
): string {
  return `<span class="ag${extra ? ` ${extra}` : ""}" data-animal="${animal}" data-c="${color}" aria-hidden="true"${attrs}>${agentSvg(animal)}</span>`;
}
