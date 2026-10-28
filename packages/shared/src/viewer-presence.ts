import { z } from "zod";

/** Viewer presence: who has an artifact open, on the R.events socket. See HOSTED_CONTRACT.md. */

export const PRESENCE_PING_MS = 30_000;
export const PRESENCE_STALE_MS = 60_000;
export const PRESENCE_SWEEP_MS = 30_000;
export const PRESENCE_GRACE_MS = 5_000;
export const PRESENCE_COALESCE_MS = 1_000;
export const AGENT_PRESENT_MS = 120_000;

/** Session cookie (app origin) holding the anonymous presence id. */
export const PRESENCE_COOKIE = "oa_pid";
export const PRESENCE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** The only client message on R.events; the server answers `pong` without waking. */
export const PRESENCE_PING = "ping";
export const PRESENCE_PONG = "pong";
export const PRESENCE_PALETTE_SIZE = 9;
export const PRESENCE_NAME_MAX = 80;
export const PRESENCE_ACTIVITY_MAX = 80;
export const PRESENCE_LIST_MAX = 100;
/** The per-artifact opaque key: 16 chars of an HMAC. */
export const PRESENCE_KEY_RE = /^[A-Za-z0-9_-]{16}$/;

export const PresenceKeySchema = z.string().regex(PRESENCE_KEY_RE);
export type PresenceKey = z.infer<typeof PresenceKeySchema>;

/**
 * 58 family-friendly animals. `lucide: true` marks the 13 with an icon in
 * lucide-react (MouseIcon is the computer mouse, so no mouse); the rest are drawn.
 */
export const ANIMALS = [
  { id: "bird", name: "Bird", lucide: true },
  { id: "bug", name: "Bug", lucide: true },
  { id: "cat", name: "Cat", lucide: true },
  { id: "dog", name: "Dog", lucide: true },
  { id: "fish", name: "Fish", lucide: true },
  { id: "panda", name: "Panda", lucide: true },
  { id: "rabbit", name: "Rabbit", lucide: true },
  { id: "rat", name: "Rat", lucide: true },
  { id: "shrimp", name: "Shrimp", lucide: true },
  { id: "snail", name: "Snail", lucide: true },
  { id: "squirrel", name: "Squirrel", lucide: true },
  { id: "turtle", name: "Turtle", lucide: true },
  { id: "worm", name: "Worm", lucide: true },
  { id: "duck", name: "Duck", lucide: false },
  { id: "capybara", name: "Capybara", lucide: false },
  { id: "axolotl", name: "Axolotl", lucide: false },
  { id: "llama", name: "Llama", lucide: false },
  { id: "badger", name: "Badger", lucide: false },
  { id: "bear", name: "Bear", lucide: false },
  { id: "beaver", name: "Beaver", lucide: false },
  { id: "bee", name: "Bee", lucide: false },
  { id: "bison", name: "Bison", lucide: false },
  { id: "butterfly", name: "Butterfly", lucide: false },
  { id: "camel", name: "Camel", lucide: false },
  { id: "chameleon", name: "Chameleon", lucide: false },
  { id: "chipmunk", name: "Chipmunk", lucide: false },
  { id: "cow", name: "Cow", lucide: false },
  { id: "crab", name: "Crab", lucide: false },
  { id: "deer", name: "Deer", lucide: false },
  { id: "dolphin", name: "Dolphin", lucide: false },
  { id: "eagle", name: "Eagle", lucide: false },
  { id: "elephant", name: "Elephant", lucide: false },
  { id: "falcon", name: "Falcon", lucide: false },
  { id: "ferret", name: "Ferret", lucide: false },
  { id: "flamingo", name: "Flamingo", lucide: false },
  { id: "fox", name: "Fox", lucide: false },
  { id: "frog", name: "Frog", lucide: false },
  { id: "giraffe", name: "Giraffe", lucide: false },
  { id: "goat", name: "Goat", lucide: false },
  { id: "hedgehog", name: "Hedgehog", lucide: false },
  { id: "heron", name: "Heron", lucide: false },
  { id: "horse", name: "Horse", lucide: false },
  { id: "koala", name: "Koala", lucide: false },
  { id: "lemur", name: "Lemur", lucide: false },
  { id: "lobster", name: "Lobster", lucide: false },
  { id: "otter", name: "Otter", lucide: false },
  { id: "owl", name: "Owl", lucide: false },
  { id: "parrot", name: "Parrot", lucide: false },
  { id: "penguin", name: "Penguin", lucide: false },
  { id: "pig", name: "Pig", lucide: false },
  { id: "quokka", name: "Quokka", lucide: false },
  { id: "seal", name: "Seal", lucide: false },
  { id: "sheep", name: "Sheep", lucide: false },
  { id: "sloth", name: "Sloth", lucide: false },
  { id: "swan", name: "Swan", lucide: false },
  { id: "tiger", name: "Tiger", lucide: false },
  { id: "whale", name: "Whale", lucide: false },
  { id: "wolf", name: "Wolf", lucide: false },
] as const satisfies readonly { id: string; name: string; lucide: boolean }[];
export type AnimalId = (typeof ANIMALS)[number]["id"];

/**
 * One viewer. Never carries an email, user id, token id, IP or anonId.
 * `named: false` means `name` is a placeholder ("Member", "Guest",
 * "Anonymous Duck", "Agent").
 */
export const PresenceEntrySchema = z.object({
  key: PresenceKeySchema,
  kind: z.enum(["person", "anon", "agent"]),
  name: z.string().max(PRESENCE_NAME_MAX),
  named: z.boolean(),
  color: z
    .number()
    .int()
    .min(0)
    .max(PRESENCE_PALETTE_SIZE - 1),
  animal: z.string().optional(),
  agent: z
    .object({
      owner: z.string().max(PRESENCE_NAME_MAX),
      product: z.string().max(PRESENCE_NAME_MAX).optional(),
      label: z.string().max(PRESENCE_NAME_MAX).optional(),
      state: z.enum(["viewing", "editing"]),
      activity: z.string().max(PRESENCE_ACTIVITY_MAX).optional(),
    })
    .optional(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

/** Most recent arrival first; `total` counts viewers beyond the list cap. */
export const PresenceFrameSchema = z.object({
  type: z.literal("presence"),
  viewers: z.array(PresenceEntrySchema).max(PRESENCE_LIST_MAX),
  total: z.number().int().min(0),
});
export type PresenceFrame = z.infer<typeof PresenceFrameSchema>;

/** Server-internal RPC arg for an agent read or write. `ownerActor` (`u:{id}`) never goes to clients. */
export type AgentTouch = {
  key: string;
  product: string | null;
  owner: string;
  ownerActor: string;
  label: string | null;
  write: boolean;
  activity: string | null;
};
