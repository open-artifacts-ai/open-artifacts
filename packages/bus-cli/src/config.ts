import { join } from "node:path";
import { busHome, daemonSocketPath } from "@oa/bus-adapter-claude-code";

export const home = () => busHome();
export const socketPath = () => daemonSocketPath(home());
export const machinePath = () => join(home(), "machine.json");
export const configPath = () => join(home(), "config.json");
export const installStatePath = () => join(home(), "install.json");
