import { SavedGameSchema, type SavedGame } from "../core/Schemas";

// Portable, gzip-compressed save files. A local (browser) save is exported as
// `<label>-<gameID>.json.gz` and can be re-imported on any machine/browser,
// independent of the server or its storage. The wire format is the same
// SavedGame the IndexedDB store holds, gzipped.

export const SAVE_FILE_EXTENSION = ".json.gz";

// Cap on a file offered for import. A local save is itself capped at 64 MiB
// (MAX_SAVE_BYTES), so a compressed export is comfortably under this; the cap
// only exists so a wrongly-chosen multi-GB file cannot exhaust memory.
export const MAX_SAVE_FILE_BYTES = 64 * 1024 * 1024;

// Cap on the decompressed JSON. Bounds a gzip bomb: a tiny file must not expand
// into unbounded memory. Generous relative to the largest real save.
export const MAX_SAVE_FILE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

const MAX_FILENAME_STEM = 60;
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

// Matches the codec's stream types: the DOM writable side is BufferSource while
// the generic streams are Uint8Array. Types only; the runtime contract is
// unchanged.
type GzipTransform = ReadableWritablePair<Uint8Array, Uint8Array>;

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("save file exceeds the size limit");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = bytesToStream(input).pipeThrough(
    new CompressionStream("gzip") as unknown as GzipTransform,
  );
  return await collectStream(stream, Number.POSITIVE_INFINITY);
}

async function gunzipBytes(
  input: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = bytesToStream(input).pipeThrough(
    new DecompressionStream("gzip") as unknown as GzipTransform,
  );
  return await collectStream(stream, maxBytes);
}

function isGzip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1
  );
}

/** A filesystem-safe filename for a save: `<sanitized label>-<gameID>.json.gz`. */
export function saveFileName(
  save: Pick<SavedGame, "label" | "gameID">,
): string {
  const stem = save.label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[_\-.]+|[_\-.]+$/g, "")
    .slice(0, MAX_FILENAME_STEM);
  return `${stem.length > 0 ? stem : "save"}-${save.gameID}${SAVE_FILE_EXTENSION}`;
}

/** Serialize a save to a gzipped JSON byte array. */
export async function encodeSaveFile(save: SavedGame): Promise<Uint8Array> {
  const parsed = SavedGameSchema.safeParse(save);
  if (!parsed.success) {
    throw new Error("refusing to export an invalid save");
  }
  const json = JSON.stringify(parsed.data);
  return await gzipBytes(new TextEncoder().encode(json));
}

/**
 * Parse a save file. Accepts a gzipped export (the default) and, defensively, a
 * plain JSON save, so a hand-edited file still imports. Throws a plain Error on
 * anything that is not a structurally valid SavedGame.
 */
export async function decodeSaveFile(
  bytes: Uint8Array,
  maxUncompressedBytes = MAX_SAVE_FILE_UNCOMPRESSED_BYTES,
): Promise<SavedGame> {
  let json: string;
  if (isGzip(bytes)) {
    const decompressed = await gunzipBytes(bytes, maxUncompressedBytes);
    json = new TextDecoder().decode(decompressed);
  } else {
    if (bytes.length > maxUncompressedBytes) {
      throw new Error("save file exceeds the size limit");
    }
    json = new TextDecoder().decode(bytes);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("not a valid save file");
  }
  const parsed = SavedGameSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("not a valid save file");
  }
  return parsed.data;
}

/** Trigger a browser download of an exported save. */
export function downloadSaveFile(bytes: Uint8Array, filename: string): void {
  // The DOM types reject a Uint8Array over a possibly-shared ArrayBuffer; at
  // runtime a BlobPart accepts any typed array's bytes.
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/gzip",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
