// A doc made by New doc opens with its title selected; any other doc opens with
// the cursor in the body. In memory: a reload is "any other doc".
const fresh = new Set<string>();
export const markFresh = (id: string) => void fresh.add(id);
export const isFresh = (id: string) => fresh.has(id);
export const clearFresh = (id: string) => void fresh.delete(id);
