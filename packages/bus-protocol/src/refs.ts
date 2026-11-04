import { z } from "zod";
import { LIMITS } from "./limits.js";
import { BAD_NS_CHARS } from "./namespace.js";

const FORBIDDEN_REFS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The daemon's local, stable handle for one harness session: a Claude
 * `sessionId`, an OpenCode root `ses_…`, a Pi session id. Opaque to the hub.
 * Restricted so it is safe as an object key and in logs.
 */
export const AgentRefSchema = z
  .string()
  .max(LIMITS.maxAgentRefChars)
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
  .refine((s) => !FORBIDDEN_REFS.has(s), "invalid agent ref");

/** A machine label shown to humans: no control, bidi or zero-width characters. */
export const MachineLabelSchema = z
  .string()
  .min(1)
  .max(2 * LIMITS.maxLabelChars)
  .refine(
    (s) => s === s.trim() && !BAD_NS_CHARS.test(s),
    "invalid machine label",
  );
