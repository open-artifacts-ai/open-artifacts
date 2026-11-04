/**
 * Pure merges for harness config files. Each returns a new document, touches
 * only the one entry it names, and throws rather than clobber a key whose
 * shape it does not understand.
 */
export type Doc = Record<string, unknown>;
export type McpServer = Record<string, unknown>;

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function record(doc: Doc, key: string, where = key): Doc | undefined {
  const v = doc[key];
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new Error(`${where} is not an object`);
  return v;
}

/** Claude Code: `mcpServers.<name>`. */
export function upsertMcpServer(
  doc: Doc,
  name: string,
  server: McpServer,
): Doc {
  return {
    ...doc,
    mcpServers: { ...record(doc, "mcpServers"), [name]: server },
  };
}

export function removeMcpServer(doc: Doc, name: string): Doc {
  const servers = record(doc, "mcpServers");
  if (servers === undefined) return doc;
  const { [name]: _, ...rest } = servers;
  return { ...doc, mcpServers: rest };
}

export * from "./jsonc.ts";
