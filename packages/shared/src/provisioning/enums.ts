import { z } from "zod";
import {
  AUTH_PROVIDERS,
  HEALTH_VALUES,
  INSTALL_STATES,
  JOB_KINDS,
  JOB_STATUSES,
  PRINCIPAL_KINDS,
  PROVISIONING_ENVS,
  SERVING_MODES,
  TOKEN_KINDS,
  TOKEN_SCOPES,
} from "./enum-values.js";

export { type Tier, TierSchema } from "../hosted/core.js";
// The values and their types live in enum-values.ts (zod-free).
export * from "./enum-values.js";

export const InstallStateSchema = z.enum(INSTALL_STATES);
export const ServingModeSchema = z.enum(SERVING_MODES);
export const HealthSchema = z.enum(HEALTH_VALUES);
export const AuthProviderSchema = z.enum(AUTH_PROVIDERS);
export const JobKindSchema = z.enum(JOB_KINDS);
export const JobStatusSchema = z.enum(JOB_STATUSES);
export const TokenScopeSchema = z.enum(TOKEN_SCOPES);
export const PrincipalKindSchema = z.enum(PRINCIPAL_KINDS);
export const TokenKindSchema = z.enum(TOKEN_KINDS);
export const EnvSchema = z.enum(PROVISIONING_ENVS);
