// The install registry lives in @oa/broker-core, shared with the directory
// broker (both read it, neither writes it).
export {
  clearRegistryCache,
  lookupInstall,
  type RegistryEntry,
  type RegistryKey,
} from "@oa/broker-core";
