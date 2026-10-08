import {
  EmojiMessage,
  NukeState,
  PlayerID,
  PlayerType,
  SamLauncherState,
  Team,
  TrainType,
  TransportShipState,
  UnitType,
  WarshipState,
} from "./game/Game";
import { TileRef } from "./game/GameMap";
import { PseudoRandomState } from "./PseudoRandom";
import { AllPlayersStats, ClientID } from "./Schemas";
import { PlayerStats } from "./StatsSchemas";

/**
 * B2 core checkpoints.
 *
 * A checkpoint captures the authoritative deterministic state of a running
 * `GameImpl` so a resume only has to replay the turn suffix that follows it,
 * instead of the whole history. Derived state (unit spatial grid, player
 * border-tile sets, pathfinder caches, water graph) is deliberately not stored:
 * it is rebuilt from the authoritative state on restore.
 *
 * The format is versioned and `gitCommit`-pinned like the rest of the save
 * system: a checkpoint from a different build may not replay identically.
 */
// 4: trade-ship checkpoints capture the source port owner/tile so a ship that
// outlived its (deleted) source port can be restored instead of forcing a
// full-history replay.
// 5: capture the target unit's type/owner (a unit can outlive its target); the
// trade/transport pathfinder stagger and the train route/endpoint station
// descriptors; and deep-copy nested unit state so a checkpoint is a true
// snapshot. Old blobs are rejected and fall back to full-history replay.
export const CHECKPOINT_VERSION = 5;

// Checkpoints are captured on demand (the in-game save button), not on a fixed
// cadence: the player decides when to pay the capture/encode cost. The only hard
// requirement is that a checkpoint's tick is at or behind the server's turn
// count, so the replayed suffix is never incomplete.

export interface MapStateCheckpoint {
  terrain: Uint8Array;
  state: Uint16Array;
  numLandTiles: number;
  numTilesWithFallout: number;
  waterVersion: number;
}

export interface UnitTollCheckpoint {
  tollerSmallID: number;
  percent: number;
  gold: bigint;
  tile: TileRef;
}

export interface UnitCheckpoint {
  id: number;
  type: UnitType;
  ownerId: PlayerID;
  tile: TileRef;
  lastTile: TileRef;
  active: boolean;
  targetTile: TileRef | null;
  targetPlayerId: PlayerID | null;
  targetIsTerraNullius: boolean;
  targetUnitId: number | null;
  /**
   * Type/owner of the targeted unit. A unit can outlive its target (e.g. a train
   * car whose destination station was destroyed), and `Unit.hash()` folds in the
   * target id, so restore has to reproduce the dangling reference. These fields
   * let an inert stub be rebuilt when the target unit itself is gone.
   */
  targetUnitType: UnitType | null;
  targetUnitOwnerId: PlayerID | null;
  health: bigint;
  troops: number;
  lastSetSafeFromPirates: number;
  transportShipState: TransportShipState | null;
  warshipState: WarshipState | null;
  nukeState: NukeState | null;
  reachedTarget: boolean;
  underConstruction: boolean;
  lastOwnerId: PlayerID | null;
  missileTimerQueue: number[];
  hasTrainStation: boolean;
  fleetId: number | null;
  level: number;
  targetable: boolean;
  loaded: boolean | null;
  trainType: TrainType | null;
  deletionAt: number | null;
  samLauncherState: SamLauncherState | null;
  defensePostUpgradeFinishTick: number | null;
  tollTicks: number[];
  tolls: UnitTollCheckpoint[];
}

export interface AttackCheckpoint {
  id: string;
  attackerId: PlayerID;
  /** null when the target is TerraNullius. */
  targetId: PlayerID | null;
  troops: number;
  sourceTile: TileRef | null;
  border: TileRef[];
  active: boolean;
  retreating: boolean;
  retreated: boolean;
}

export type AllianceRequestStatus = "pending" | "accepted" | "rejected";

export interface AllianceRequestCheckpoint {
  requestorId: PlayerID;
  recipientId: PlayerID;
  createdAt: number;
  /**
   * Only meaningful for a resolved request kept in a player's outgoing history.
   * Absent in checkpoints written before history was captured (treated as
   * pending). Pending requests are restored via `GameImpl.allianceRequests`.
   */
  status?: AllianceRequestStatus;
}

/**
 * B2: a live `AllianceRequestExecution`. The execution owns a reference to the
 * pending `AllianceRequest`, which is re-linked by requestor/recipient/createdAt
 * on restore (the request itself is restored from `GameCheckpoint.allianceRequests`).
 */
export interface AllianceRequestExecutionCheckpoint {
  requestorId: PlayerID;
  recipientId: PlayerID;
  active: boolean;
  /** `null` when the execution had not created a request yet. */
  requestCreatedAt: number | null;
}

export interface AllianceCheckpoint {
  id: number;
  requestorId: PlayerID;
  recipientId: PlayerID;
  createdAt: number;
  expiresAt: number;
  extensionRequestedRequestor: boolean;
  extensionRequestedRecipient: boolean;
}

export interface TrainStationCheckpoint {
  id: number;
  unitId: number;
}

export interface RailroadCheckpoint {
  id: number;
  fromStationId: number;
  toStationId: number;
  tiles: TileRef[];
}

/**
 * B2: the rail network's authoritative state. The station/railroad objects are
 * rebuilt on restore from these ids; the cluster partition is stored explicitly
 * because it can temporarily disagree with pure railroad connectivity (removing
 * a station marks its cluster dirty until RecomputeRailClusterExecution splits
 * it).
 */
export interface RailNetworkCheckpoint {
  nextStationId: number;
  nextRailroadId: number;
  stations: TrainStationCheckpoint[];
  railroads: RailroadCheckpoint[];
  /** Station ids per cluster; `dirtyClusterIndices` indexes into this array. */
  clusters: number[][];
  dirtyClusterIndices: number[];
}

export interface TrainStationExecutionCheckpoint {
  unitId: number;
  spawnTrains: boolean;
  active: boolean;
  stationId: number | null;
  numCars: number;
  lastSpawnTick: number;
  ticksCooldown: number;
  random: PseudoRandomState | null;
}

export interface TrainStationRefCheckpoint {
  id: number;
  unitId: number;
  ownerId: PlayerID;
  type: UnitType;
  tile: TileRef;
}

export interface TrainExecutionCheckpoint {
  playerId: PlayerID;
  numCars: number;
  active: boolean;
  trainUnitId: number | null;
  carUnitIds: number[];
  hasCargo: boolean;
  currentTile: number;
  spacing: number;
  usedTiles: TileRef[];
  /**
   * The train's route stations. Captured as identity + owner + tile rather than
   * just ids because a route station can be removed mid-journey (its unit was
   * destroyed) while an active train still holds it; on restore the station is
   * rebuilt from this descriptor even when the station manager no longer has it.
   */
  stations: TrainStationRefCheckpoint[];
  /** The train's original endpoints (may no longer be in `stations`). */
  source: TrainStationRefCheckpoint;
  destination: TrainStationRefCheckpoint;
  speed: number;
  tradeStopsVisited: number;
  pathTiles: TileRef[];
  pathIndex: number;
}

/**
 * B2: the immutable `PlayerInfo` of a player, captured so a checkpoint can
 * recreate players that were added *after* game construction. `GameImpl`
 * constructs only humans + map nations; bot tribes are appended during play by
 * `SpawnExecution`, so a late-game checkpoint's roster is larger than a freshly
 * built game's. Without this, restore silently dropped those players.
 */
export interface PlayerInfoCheckpoint {
  name: string;
  playerType: PlayerType;
  clientID: ClientID | null;
  id: PlayerID;
  isLobbyCreator: boolean;
  clanTag: string | null;
  friends: ClientID[];
  teamIndex: number | null;
  nationFlag: string | null;
}

export interface PlayerCheckpoint {
  id: PlayerID;
  smallID: number;
  /** Roster entry so a missing player can be recreated on restore. */
  playerInfo: PlayerInfoCheckpoint;
  gold: bigint;
  troops: bigint;
  tradeGold: bigint;
  trainGold: bigint;
  piracyGold: bigint;
  goldEarned: bigint;
  numUnitsConstructed: [UnitType, number][];
  /**
   * Owned tiles are deliberately NOT captured: they are redundant with
   * `GameCheckpoint.map.state` (the per-tile owner array) and are rebuilt from
   * it on restore. Serializing every ref dominated large-map checkpoints.
   */
  avoidedTiles: TileRef[];
  /**
   * The player's border tiles, in insertion order. Unlike owned tiles these are
   * captured: several consumers (e.g. AttackExecution.refreshToConquer) assign
   * per-neighbour PRNG draws by iterating them, so rebuilding them from the
   * ownership map in a different order changes the simulation. The border is
   * O(perimeter), a small fraction of the owned set.
   */
  borderTiles: TileRef[];
  unitIds: number[];
  /**
   * Persistent informational rail links between this player's own factories,
   * as `[factoryAId, factoryBId, railroadUnitId]`. Optional for checkpoints
   * written before the feature existed.
   */
  railroadLinks?: [number, number, number][];
  allianceIds: number[];
  outgoingAttackIds: string[];
  incomingAttackIds: string[];
  spawnTile: TileRef | null;
  isDisconnected: boolean;
  markedTraitorTick: number;
  markedDoomsdayClockTick: number;
  rottedAtTick: number;
  betrayalCount: number;
  universalTollRate: number;
  lastDeleteUnitTick: number;
  lastEmbargoAllTick: number;
  lastTileChange: number;
  relations: [number, number][];
  tollRates: [PlayerID, number][];
  embargoes: {
    targetId: PlayerID;
    createdAt: number;
    isTemporary: boolean;
  }[];
  targets: { tick: number; targetId: PlayerID }[];
  outgoingEmojis: EmojiMessage[];
  outgoingQuickChats: [number, number][];
  sentDonations: { recipientId: PlayerID; tick: number }[];
  pseudoRandom: PseudoRandomState;
  /**
   * Resolved alliance requests this player sent, in insertion order. Drives the
   * per-recipient request cooldown in `canSendAllianceRequest`, so it is part of
   * the deterministic state. Optional for checkpoints written before the
   * history was captured.
   */
  pastOutgoingAllianceRequests?: AllianceRequestCheckpoint[];
  /**
   * Alliances this player was once part of, in insertion order. Optional for
   * checkpoints written before the history was captured.
   */
  expiredAlliances?: AllianceCheckpoint[];
}

export interface ExecutionCheckpoint {
  kind: string;
  data: unknown;
}

/**
 * B2: process-global counters that ship pathfinders draw from. They are not
 * per-game fields, but they are part of the deterministic state: restoring them
 * keeps a resumed run's rebuild stagger in lockstep with the run it continues.
 */
export interface PathfinderStaticsCheckpoint {
  tradeShipStagger: number;
  transportShipStagger: number;
}

export type CheckpointWinner =
  | { kind: "player"; id: PlayerID }
  | { kind: "team"; team: Team }
  | null;

export interface GameCheckpoint {
  version: number;
  ticks: number;
  startTick: number | null;
  isPaused: boolean;
  winner: CheckpointWinner;
  nextPlayerID: number;
  nextUnitID: number;
  nextFleetId: number;
  nextAllianceID: number;
  unitsVersion: number;
  territoryVersion: number;
  map: MapStateCheckpoint;
  miniMap: MapStateCheckpoint;
  players: PlayerCheckpoint[];
  units: UnitCheckpoint[];
  attacks: AttackCheckpoint[];
  allianceRequests: AllianceRequestCheckpoint[];
  alliances: AllianceCheckpoint[];
  stats: AllPlayersStats;
  numMirvsLaunched: bigint;
  /** Executions that had already run, in tick order. */
  executions: ExecutionCheckpoint[];
  /** Number of leading `executions` entries that were active (not pending). */
  execsCount: number;
  /** Optional for checkpoints written before pathfinder statics were captured. */
  pathfinderStatics?: PathfinderStaticsCheckpoint;
  /** Optional for checkpoints written before the rail network was captured. */
  railNetwork?: RailNetworkCheckpoint;
}

/** Serialized form of a `PlayerStats` record (bigints survive structured clone). */
export type CheckpointPlayerStats = PlayerStats;

export type CheckpointClientID = ClientID;

/**
 * True when a value looks like a B2 checkpoint. Cheap structural guard used at
 * the persistence boundary before a full parse.
 */
export function isGameCheckpoint(value: unknown): value is GameCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const cp = value as Partial<GameCheckpoint>;
  return (
    cp.version === CHECKPOINT_VERSION &&
    typeof cp.ticks === "number" &&
    Array.isArray(cp.players) &&
    Array.isArray(cp.units) &&
    typeof cp.map === "object" &&
    cp.map !== null
  );
}
