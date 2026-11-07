// #779: iPhones save photos as HEIC/HEIF, which only Safari can draw, so the
// dashboard re-encodes one as JPEG before the upload starts. The server still
// refuses HEIC (agents keep the clear unsupported_format answer); a browser
// that can't decode HEIF keeps the "export it as JPEG" refusal too.

const HEIC = new Set(["heic", "heif"]);

const extOf = (path: string) => {
  const i = path.lastIndexOf(".");
  return i <= 0 ? "" : path.slice(i + 1).toLowerCase();
};

/** The path that carries the file: a dropped folder's relative path, else its name. */
const pathOf = (file: File) => file.webkitRelativePath || file.name;

export const isHeicPath = (path: string) => HEIC.has(extOf(path));

/** "photos/one.heic" → "photos/one.jpg": only the extension changes. */
export const jpegPath = (path: string) => {
  const i = path.lastIndexOf(".");
  return i <= 0 ? `${path}.jpg` : `${path.slice(0, i)}.jpg`;
};

/** The same bytes under a new path and name, the dropped folder's path kept. */
const renamed = (blob: Blob, from: File, path: string): File => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const out = new File([blob], name, {
    type: "image/jpeg",
    lastModified: from.lastModified,
  });
  if (from.webkitRelativePath)
    Object.defineProperty(out, "webkitRelativePath", { value: path });
  return out;
};

/**
 * One HEIC photo as JPEG, decoded and re-encoded by this browser, or null when
 * it can't decode HEIF (most browsers outside Safari, and every test env).
 * Orientation comes from the file, as createImageBitmap reads it.
 */
export async function heicToJpeg(file: File): Promise<File | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const jpeg = await new Promise<Blob | null>((done) =>
      canvas.toBlob(done, "image/jpeg", 0.92),
    );
    return jpeg ? renamed(jpeg, file, jpegPath(pathOf(file))) : null;
  } catch {
    // A decode this browser can't do, or a canvas it won't give us: leave the
    // file alone and let the entry check say what to do.
    return null;
  }
}

/**
 * The picked files, with every HEIC photo this browser can decode swapped for
 * its JPEG (`converted`), and the rest untouched. Never throws: a failed
 * conversion leaves the original in place, so the upload keeps its own refusal.
 */
export async function convertHeicPhotos(
  files: File[],
): Promise<{ files: File[]; converted: string[] }> {
  const heic = files.filter((f) => isHeicPath(pathOf(f)));
  if (heic.length === 0) return { files, converted: [] };
  const done = new Map<File, File>();
  for (const file of heic) {
    const jpeg = await heicToJpeg(file);
    if (jpeg) done.set(file, jpeg);
  }
  if (done.size === 0) return { files, converted: [] };
  const converted = [...done.keys()].map((f) => pathOf(f));
  return { files: files.map((f) => done.get(f) ?? f), converted };
}
