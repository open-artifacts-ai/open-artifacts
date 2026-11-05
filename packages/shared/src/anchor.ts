import { z } from "zod";

// Comment anchors (#682). One file on purpose: the Backend may still change
// the shape, so every type and cap lives here.

export const ANCHOR_LIMITS = {
  exact: 1000,
  context: 64,
  path: 256,
  contentHash: 128,
} as const;

const version = z.number().int().min(1);
const unit = z.number().min(0).max(1);

export const blockHintSchema = z.strictObject({
  path: z.string().max(ANCHOR_LIMITS.path).optional(),
  line: z.number().int().min(1).optional(),
  page: z.number().int().min(1).optional(),
});

export const noteAnchorSchema = z.strictObject({ kind: z.literal("note") });

export const textAnchorSchema = z.strictObject({
  kind: z.literal("text"),
  version,
  exact: z.string().min(1).max(ANCHOR_LIMITS.exact),
  prefix: z.string().max(ANCHOR_LIMITS.context),
  suffix: z.string().max(ANCHOR_LIMITS.context),
  block: blockHintSchema.optional(),
});

export const pinAnchorSchema = z.strictObject({
  kind: z.literal("pin"),
  version,
  page: z.number().int().min(1).optional(),
  x: unit,
  y: unit,
  contentHash: z.string().min(1).max(ANCHOR_LIMITS.contentHash),
});

export const anchorSchema = z.discriminatedUnion("kind", [
  noteAnchorSchema,
  textAnchorSchema,
  pinAnchorSchema,
]);

export type BlockHint = z.infer<typeof blockHintSchema>;
export type NoteAnchor = z.infer<typeof noteAnchorSchema>;
export type TextAnchor = z.infer<typeof textAnchorSchema>;
export type PinAnchor = z.infer<typeof pinAnchorSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
