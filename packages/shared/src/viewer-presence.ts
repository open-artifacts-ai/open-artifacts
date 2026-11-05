/**
 * Viewer presence: who else has this artifact open (Drive-style faces).
 * Frames ride the R.events socket as `{ type: "presence" }`. Nothing here
 * carries an email, user id, token id, IP or anonId: `key` is an opaque
 * per-artifact value that cannot link a viewer across artifacts.
 */
import { z } from "zod";

/** Client ping cadence; the DO answers "pong" without waking. */
export const PRESENCE_PING_MS = 30_000;
/** A `?ping=1` socket with no ping for this long is stale. */
export const PRESENCE_STALE_MS = 60_000;
/** How often the alarm looks for stale sockets. */
export const PRESENCE_SWEEP_MS = 30_000;
/** A closed socket's face stays this long, so a reload does not flicker. */
export const PRESENCE_GRACE_MS = 5_000;
/** Join, leave and expiry frames are coalesced over this window. */
export const PRESENCE_COALESCE_MS = 1_000;
/** An agent counts as present this long after its last touch (and as editing after its last write). */
export const AGENT_PRESENT_MS = 120_000;

/** Session cookie holding the anonymous presence id (app origin). */
export const PRESENCE_COOKIE = "oa_pid";
/** The server treats the cookie value as opaque; anything else is ignored. */
export const PRESENCE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** The per-artifact key shown to clients. */
export const PRESENCE_KEY_RE = /^[A-Za-z0-9_-]{16}$/;
export const PRESENCE_PING = "ping";
export const PRESENCE_PONG = "pong";
export const PRESENCE_PALETTE_SIZE = 9;
export const PRESENCE_NAME_MAX = 80;
export const PRESENCE_ACTIVITY_MAX = 80;
export const PRESENCE_LIST_MAX = 100;

const animal = (id: string, name: string, lucide = false) =>
  ({ id, name, lucide }) as const;

/**
 * Family-friendly animals for anonymous viewers. The 13 with `lucide: true`
 * have an animal icon in lucide-react 1.59.0 (its MouseIcon is the computer
 * mouse, so there is no mouse); the rest are drawn.
 */
export const ANIMALS = [
  animal("bird", "Bird", true),
  animal("bug", "Bug", true),
  animal("cat", "Cat", true),
  animal("dog", "Dog", true),
  animal("fish", "Fish", true),
  animal("panda", "Panda", true),
  animal("rabbit", "Rabbit", true),
  animal("rat", "Rat", true),
  animal("shrimp", "Shrimp", true),
  animal("snail", "Snail", true),
  animal("squirrel", "Squirrel", true),
  animal("turtle", "Turtle", true),
  animal("worm", "Worm", true),
  animal("duck", "Duck"),
  animal("capybara", "Capybara"),
  animal("axolotl", "Axolotl"),
  animal("llama", "Llama"),
  animal("fox", "Fox"),
  animal("owl", "Owl"),
  animal("bear", "Bear"),
  animal("wolf", "Wolf"),
  animal("deer", "Deer"),
  animal("horse", "Horse"),
  animal("cow", "Cow"),
  animal("pig", "Pig"),
  animal("sheep", "Sheep"),
  animal("goat", "Goat"),
  animal("lion", "Lion"),
  animal("tiger", "Tiger"),
  animal("zebra", "Zebra"),
  animal("giraffe", "Giraffe"),
  animal("elephant", "Elephant"),
  animal("hippo", "Hippo"),
  animal("rhino", "Rhino"),
  animal("monkey", "Monkey"),
  animal("koala", "Koala"),
  animal("kangaroo", "Kangaroo"),
  animal("otter", "Otter"),
  animal("beaver", "Beaver"),
  animal("hedgehog", "Hedgehog"),
  animal("penguin", "Penguin"),
  animal("parrot", "Parrot"),
  animal("flamingo", "Flamingo"),
  animal("swan", "Swan"),
  animal("eagle", "Eagle"),
  animal("frog", "Frog"),
  animal("dolphin", "Dolphin"),
  animal("whale", "Whale"),
  animal("seal", "Seal"),
  animal("octopus", "Octopus"),
  animal("crab", "Crab"),
  animal("jellyfish", "Jellyfish"),
  animal("butterfly", "Butterfly"),
  animal("bee", "Bee"),
  animal("ladybug", "Ladybug"),
  animal("gecko", "Gecko"),
  animal("camel", "Camel"),
  animal("moose", "Moose"),
  animal("raccoon", "Raccoon"),
] as const;
export type AnimalId = (typeof ANIMALS)[number]["id"];

/**
 * One face on the roster. `named: false` means `name` is a placeholder
 * ("Member", "Guest", "Anonymous Duck", "Agent"). `agent.label` is an owner's
 * private token label and is sent only to that owner.
 */
export const PresenceEntrySchema = z.object({
  key: z.string().regex(PRESENCE_KEY_RE),
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

/** Most recent arrival first; at most PRESENCE_LIST_MAX viewers, `total` counts all. */
export const PresenceFrameSchema = z.object({
  type: z.literal("presence"),
  viewers: z.array(PresenceEntrySchema).max(PRESENCE_LIST_MAX),
  total: z.number().int().min(0),
});
export type PresenceFrame = z.infer<typeof PresenceFrameSchema>;

/** The caller's own key, on `hello`. */
export const PresenceKeySchema = z.string().regex(PRESENCE_KEY_RE);

/**
 * An agent's touch (server-internal RPC argument; never sent to clients).
 * `ownerActor` is `u:{id}`.
 */
export type AgentTouch = {
  key: string;
  product: string | null;
  owner: string;
  ownerActor: string;
  label: string | null;
  write: boolean;
  activity: string | null;
};
