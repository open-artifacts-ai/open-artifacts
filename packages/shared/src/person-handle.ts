import { z } from "zod";

export const PersonHandleSchema = z
  .string()
  .regex(/^[a-z0-9._-]{2,30}$/i)
  .transform((value) => value.toLowerCase());

export function suggestedHandle(name: string): string {
  const base = name
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return base.length >= 2 ? base : base ? base + "-1" : "member";
}

export const HandleAvailabilitySchema = z.object({
  available: z.boolean(),
  suggestion: z.string().nullable(),
});
