import { withAgyConfigLock } from "../../src/steps/agy-config-lock.ts";

await withAgyConfigLock(process.argv[2], () => process.exit(42));
