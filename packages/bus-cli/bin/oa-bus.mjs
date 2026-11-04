#!/usr/bin/env node
// Runs the TypeScript sources through jiti, in the workspace. The published
// package runs dist/index.js (scripts/bundle.mjs).
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/main.ts");
const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
