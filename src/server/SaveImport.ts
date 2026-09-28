import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import { decodeCheckpointWire } from "../core/CheckpointCodec";
import {
  SAVED_GAME_VERSION,
  SAVED_LOBBY_VERSION,
  SavedGameSchema,
  SavedLobbySchema,
  type Player,
  type SavedGame,
  type SavedLobby,
  type SavedLobbySeat,
} from "../core/Schemas";

const gzipAsync = promisify(gzipCb);

// Turn a locally exported save file (the gzipped `SavedGame` the client's
// SaveFile export produces) into a server-hosted `SavedLobby`, so the player can
// re-register a save as a resumable lobby after a redeploy wiped the server's
// copy. The client never gets to set the fields that matter for trust
// (creatorPersistentID, stage, gitCommit); those are supplied by the caller
// (the authenticated route), not read from the file.

/** Compressed import body cap. Matches the client's MAX_SAVE_FILE_BYTES. */
export const MAX_SAVE_IMPORT_BYTES = 64 * 1024 * 1024;
/** Decompressed cap, so a gzip bomb cannot exhaust the worker's memory. */
export const MAX_SAVE_IMPORT_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

class SaveImportError extends Error {}

function isGzip(bytes: Buffer): boolean {
  return (
    bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1
  );
}

function gunzipLimited(buffer: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzipCb(buffer, { maxOutputLength: maxBytes }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Parse an imported save file. Accepts the gzip export and, defensively, a
 * plain JSON save. Throws `SaveImportError` on anything that is not a valid
 * `SavedGame`.
 */
export async function decodeImportedSavedGame(
  bytes: Buffer,
): Promise<SavedGame> {
  let json: string;
  if (isGzip(bytes)) {
    if (bytes.length > MAX_SAVE_IMPORT_BYTES) {
      throw new SaveImportError("save file exceeds the size limit");
    }
    const decompressed = await gunzipLimited(
      bytes,
      MAX_SAVE_IMPORT_UNCOMPRESSED_BYTES,
    );
    json = decompressed.toString("utf8");
  } else {
    if (bytes.length > MAX_SAVE_IMPORT_UNCOMPRESSED_BYTES) {
      throw new SaveImportError("save file exceeds the size limit");
    }
    json = bytes.toString("utf8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SaveImportError("not a save file");
  }
  const parsed = SavedGameSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SaveImportError("not a valid save file");
  }
  return parsed.data;
}

/**
 * Convert a `SavedGame` to the server `SavedLobby` persisted by the save store.
 *
 * - `creatorPersistentID` and `gitCommit` come from the caller, never the file.
 * - The creator's own seat (matching `myClientID`) is stamped with the caller's
 *   persistentID so they auto-reconnect; other seats get an empty persistentID
 *   and can still be claimed through the invite link.
 * - The checkpoint is kept only when this build can decode it; otherwise the
 *   save resumes from the full history. `checkpointTurn` is recorded so the
 *   restore avoids a second decode.
 */
export async function savedLobbyFromSavedGame(
  save: SavedGame,
  options: {
    creatorPersistentID: string;
    gitCommit: string;
    now: number;
  },
): Promise<SavedLobby> {
  const seats: SavedLobbySeat[] = save.startInfo.players.map((player) => ({
    ...player,
    persistentID:
      player.clientID === save.myClientID ? options.creatorPersistentID : "",
    trusted: false,
    spectator: false,
  }));

  let checkpoint: string | undefined;
  let checkpointTurn: number | undefined;
  if (typeof save.checkpoint === "string") {
    const decoded = await decodeCheckpointWire(save.checkpoint);
    if (decoded !== undefined) {
      checkpoint = save.checkpoint;
      checkpointTurn = decoded.ticks;
    }
  }

  const lobby = {
    version: SAVED_LOBBY_VERSION,
    gameID: save.gameID,
    createdAt: save.startInfo.lobbyCreatedAt,
    creatorPersistentID: options.creatorPersistentID,
    gameConfig: save.startInfo.config,
    stage: "started" as const,
    seats,
    gameStartInfo: save.startInfo,
    turns: save.turns,
    ...(checkpoint !== undefined ? { checkpoint, checkpointTurn } : {}),
    savedAt: options.now,
    gitCommit: options.gitCommit,
  };
  return SavedLobbySchema.parse(lobby);
}

// Drop the server-only seat fields (persistentID, publicId, trusted, spectator)
// when a save that never started has no frozen gameStartInfo to read from.
function seatToPlayer(seat: SavedLobbySeat): Player {
  return {
    clientID: seat.clientID,
    username: seat.username,
    clanTag: seat.clanTag,
    ...(seat.cosmetics !== undefined ? { cosmetics: seat.cosmetics } : {}),
    ...(seat.isLobbyCreator !== undefined
      ? { isLobbyCreator: seat.isLobbyCreator }
      : {}),
    ...(seat.friends !== undefined ? { friends: seat.friends } : {}),
    ...(seat.teamIndex !== undefined ? { teamIndex: seat.teamIndex } : {}),
  };
}

/**
 * The inverse of {@link savedLobbyFromSavedGame}: turn a server-hosted
 * `SavedLobby` back into a portable `SavedGame` the client can download as a
 * save file. This is the only conversion allowed to hand server state to a
 * browser, so the PII-bearing seat fields (persistentID, publicId) are dropped:
 * `startInfo.players` comes from the PII-free `gameStartInfo` when present, or a
 * stripped projection of the seats when the save never started.
 */
export async function savedGameFromSavedLobby(
  save: SavedLobby,
): Promise<SavedGame> {
  const startInfo = save.gameStartInfo ?? {
    gameID: save.gameID,
    lobbyCreatedAt: save.createdAt,
    config: save.gameConfig,
    players: save.seats.map(seatToPlayer),
  };
  const creator = save.seats.find(
    (seat) => seat.persistentID === save.creatorPersistentID,
  );
  const myClientID = creator?.clientID ?? save.seats[0]?.clientID;

  let checkpoint: string | undefined;
  if (typeof save.checkpoint === "string") {
    const decoded = await decodeCheckpointWire(save.checkpoint);
    if (decoded !== undefined) {
      checkpoint = save.checkpoint;
    }
  }

  return SavedGameSchema.parse({
    version: SAVED_GAME_VERSION,
    saveId: save.gameID,
    gameID: save.gameID,
    label: startInfo.players[0]?.username
      ? `${startInfo.config.gameMap} · ${startInfo.players[0].username}`
      : startInfo.config.gameMap,
    savedAt: save.savedAt,
    gitCommit: save.gitCommit,
    ...(myClientID !== undefined ? { myClientID } : {}),
    startInfo,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    turns: save.turns,
  });
}

/** Gzip a portable save file exactly as the client's SaveFile export does. */
export async function encodeExportedSavedGame(
  save: SavedGame,
): Promise<Buffer> {
  return gzipAsync(Buffer.from(JSON.stringify(save), "utf8"));
}
