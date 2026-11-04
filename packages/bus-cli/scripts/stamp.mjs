// The Pi extension is copied, not bundled: bundle.mjs stamps its IPC marker here.
const PI_MARKER = 'const CLIENT_VERSION = "0.0.0";';

/** The Pi extension's source with its IPC marker set to `version`. */
export function stampPi(source, version) {
  if (!source.includes(PI_MARKER))
    throw new Error("the Pi extension has no CLIENT_VERSION to stamp");
  return source.replace(
    PI_MARKER,
    `const CLIENT_VERSION = ${JSON.stringify(version)};`,
  );
}
