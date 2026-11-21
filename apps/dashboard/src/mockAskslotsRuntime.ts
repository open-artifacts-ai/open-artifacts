// Dev only (?mock=askslots, #2426 B): loads the runtime into public/mock-askslots.html,
// with its schemas chunk taken from source (the built chunks exist only in a build).
const w = window as unknown as { openArtifacts?: unknown };
// Keeps the runtime's own startup from making a second one without the chunk.
w.openArtifacts = {};
const [{ createRuntime }, schemas] = await Promise.all([
  import("../../../packages/runtime/src/index"),
  import("../../../packages/runtime/src/schemas"),
]);
w.openArtifacts = createRuntime({
  loadSchemas: () => Promise.resolve(schemas),
});
export {};
