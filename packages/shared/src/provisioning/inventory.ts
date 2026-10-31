import { z } from "zod";
import { InstallStateSchema } from "./enums.js";
import { InstallIdSchema } from "./ids.js";

// oa-<p>-inventory responses (design v7 6.3). Read by the hourly monitor and
// red-line with GitHub OIDC.

/** The live HOSTS mode (@oa/provision parseHostsValue); null when unmapped. */
export const HostModeSchema = z
  .enum(["serving", "paused", "closed"])
  .nullable();

/**
 * One install. `appHost` and `contentHost` come from its hosts row, so they
 * are null together for an install that has none yet (a create before its
 * route step): the monitor still sees and checks it, with no route to
 * fetch, and its `mode` is then null.
 */
export const InventoryInstallSchema = z
  .object({
    id: InstallIdSchema,
    appHost: z.string().nullable(),
    contentHost: z.string().nullable(),
    /** From install_status. */
    state: InstallStateSchema,
    testHooks: z.boolean(),
    mode: HostModeSchema,
  })
  .refine((r) => (r.appHost === null) === (r.contentHost === null), {
    message: "appHost and contentHost are both set or both null",
  })
  .refine((r) => r.appHost !== null || r.mode === null, {
    message: "an install with no hosts has no HOSTS mode",
  });
export const InventoryInstallsSchema = z.object({
  installs: z.array(InventoryInstallSchema),
});

/** GET /hosts?host=: one host. */
export const InventoryHostSchema = z.object({
  host: z.string(),
  installId: InstallIdSchema.nullable(),
  mode: HostModeSchema,
});
/** GET /hosts: every host, capped (complete false past the cap). */
export const InventoryHostsSchema = z.object({
  hosts: z.array(InventoryHostSchema),
  complete: z.boolean(),
});

export const InventoryHealthSchema = z.object({
  schedulerTickAt: z.number().nullable(),
});

/** POST /prodclean, from the monitor's workflow ref only. */
export const ProdcleanReportSchema = z
  .object({
    ok: z.boolean(),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    installId: InstallIdSchema.optional(),
    detail: z.string().max(200).optional(),
  })
  .strict();
export type ProdcleanReport = z.infer<typeof ProdcleanReportSchema>;
