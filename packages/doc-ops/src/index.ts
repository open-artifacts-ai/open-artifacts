export {
  applyOpsToDoc,
  BLOCK_FORMATS,
  type BlockFormat,
  type DocOp,
  type DocOpError,
  type DocOpErrorCode,
  INLINE_MARKS,
  type InlineMark,
  MAX_OPS,
  MAX_QUOTE_CHARS,
  type OpImportChange,
  type PlanResult,
  type QuoteContext,
} from "./ops.ts";
export {
  closestText,
  findQuote,
  type QuoteLookup,
  type QuoteMatch,
  type VisibleText,
  visibleText,
} from "./text.ts";
export {
  applyDocOps,
  type EditOptions,
  type EditResult,
  MAX_DOC_BYTES,
  readDoc,
} from "./yjs.ts";
