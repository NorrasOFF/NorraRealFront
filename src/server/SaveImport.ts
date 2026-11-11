import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import {
  decodeCheckpointWire,
  MAX_CHECKPOINT_COMPRESSED_TRANSFER_BYTES,
  MAX_CHECKPOINT_DECOMPRESSED_BYTES,
} from "../core/CheckpointCodec";
import { GameType } from "../core/game/Game";
import {
  SAVED_GAME_VERSION,
  SAVED_LOBBY_VERSION,
  SavedGameSchema,
  SavedLobbySchema,
  type GameConfig,
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

/**
 * A checkpoint string in an imported file may not exceed the chunked upload cap
 * the game socket itself enforces: this build never produces a larger wire
 * checkpoint, so anything bigger is either crafted or corrupt.
 */
export const MAX_SAVE_IMPORT_CHECKPOINT_BYTES =
  MAX_CHECKPOINT_COMPRESSED_TRANSFER_BYTES;

/**
 * Decompressed ceiling for an imported checkpoint. This sits above the largest
 * shipped map's tagged-JSON checkpoint but far below what a gzip bomb would
 * demand, so a crafted file degrades to full-history replay instead of OOMing
 * the worker.
 */
export const MAX_SAVE_IMPORT_CHECKPOINT_UNCOMPRESSED_BYTES =
  MAX_CHECKPOINT_DECOMPRESSED_BYTES;

/**
 * Server-authoritative / account-bearing config fields that a save file must
 * not be able to set. A save file is entirely client-authored, so treating its
 * `ranked` flag as trustworthy would let an account mint a "ranked" match from
 * a hand-edited JSON (and farm the ladder with a second account), and `Public`
 * would bypass the master's public-game scheduling. Imported games are private
 * and unranked by construction; a player who wants a rated game must play one.
 * `allowedPublicIds` / `nameRevealPublicIds` / `nameReveals` are the host-only
 * PII allowlists the server normally keeps out of client-visible config.
 */
function importedGameConfig(config: GameConfig): GameConfig {
  const clean: GameConfig = { ...config, gameType: GameType.Private };
  delete clean.ranked;
  delete clean.rankedType;
  delete clean.allowedPublicIds;
  delete clean.nameRevealPublicIds;
  delete clean.nameReveals;
  delete clean.liveStatsEnabled;
  return clean;
}

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
  if (
    typeof save.checkpoint === "string" &&
    save.checkpoint.length <= MAX_SAVE_IMPORT_CHECKPOINT_BYTES
  ) {
    // Bounded decode: a gzip bomb or an over-size blob is dropped here and the
    // save resumes from its full turn history instead.
    const decoded = await decodeCheckpointWire(save.checkpoint, {
      maxDecompressedBytes: MAX_SAVE_IMPORT_CHECKPOINT_UNCOMPRESSED_BYTES,
    });
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
    gameConfig: importedGameConfig(save.startInfo.config),
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
    const decoded = await decodeCheckpointWire(save.checkpoint, {
      maxDecompressedBytes: MAX_SAVE_IMPORT_CHECKPOINT_UNCOMPRESSED_BYTES,
    });
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
