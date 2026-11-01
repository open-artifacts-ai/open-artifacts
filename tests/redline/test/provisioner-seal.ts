import { join } from "node:path";

// The sealer the provisioner runs (apps/provisioner/src/seal.ts), loaded at
// runtime: it is typed against workers-types, which this package does not
// use, so a static import would not typecheck here.
type SealTo = (recipientKey: string, plaintext: string) => Promise<string>;
const path = join(import.meta.dirname, "../../../apps/provisioner/src/seal.ts");
export const { sealTo } = (await import(path)) as { sealTo: SealTo };
