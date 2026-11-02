/** A step body W3 builds (design v7 13.2); until then it throws. */
export const notBuilt = (name: string): Error =>
  new Error(`${name} is not built yet (W3)`);
