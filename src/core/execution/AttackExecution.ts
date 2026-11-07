import { ExecutionCheckpoint } from "../Checkpoint";
import { AttackLogicInput, AttackLogicResult } from "../configuration/Config";
import {
  Attack,
  Difficulty,
  Execution,
  Game,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
  TerraNullius,
  UnitType,
} from "../game/Game";
import { GameMap, TileRef } from "../game/GameMap";
import { PseudoRandom, PseudoRandomState } from "../PseudoRandom";
import { assertNever } from "../Util";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap"; // adjust path if needed

export interface AttackExecutionCheckpoint {
  startTroops: number | null;
  ownerId: PlayerID;
  targetId: PlayerID | null;
  sourceTile: TileRef | null;
  removeTroops: boolean;
  active: boolean;
  random: PseudoRandomState;
  /** The `Attack` this execution drives, or null once it has been deleted. */
  attackId: string | null;
  toConquer: {
    priorities: number[];
    tiles: TileRef[];
    /** Sparse non-zero defense tiers as [heapSlot, tier] pairs. */
    tiers?: [number, number][];
  };
}

export class AttackExecution implements Execution {
  private active: boolean = true;
  private toConquer = new FlatBinaryHeap();

  private random = new PseudoRandom(123);

  private target: Player | TerraNullius;

  private mg: Game;
  // Direct GameMap reference to skip the Game delegation hop in hot loops.
  private map: GameMap;

  private attack: Attack | null = null;

  // Defense-post-aware conquest ordering. `defenseLevelCache` deduplicates
  // queries within one tick; `defensePostSignature` tracks the defender's
  // posts so the frontier is re-tiered only when their coverage may have
  // changed (build, upgrade, destruction, capture).
  private defenseLevelCache = new Map<TileRef, number>();
  private defensePostSignature: string | null = null;

  // Cached smallIDs for integer owner comparisons in hot loops.
  private ownerSmallID: number;
  private targetSmallID: number;
  // Reusable neighbor buffers to avoid closures/allocation in hot loops.
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private nbuf2: TileRef[] = [0, 0, 0, 0];

  // Reusable attackLogic input/result. `attackLogic` runs once per conquered
  // tile on every attack; allocating a fresh input object, attacker/defender
  // sub-objects and result object for each tile was a top-3 allocation site in
  // late games. The callee only reads the input synchronously, so one scratch
  // object per execution is safe.
  private readonly attackLogicInputScratch: AttackLogicInput = {
    terrain: TerrainType.Plains,
    attackTroops: 0,
    attacker: { type: PlayerType.Bot, numTiles: 0 },
    defender: null,
    defensePostLevel: 0,
    falloutRatio: null,
    borderSize: 0,
  };
  private readonly defenderScratch: NonNullable<AttackLogicInput["defender"]> =
    {
      type: PlayerType.Bot,
      numTiles: 0,
      troops: 0,
      isTraitor: false,
      isDisconnectedTeammate: false,
    };
  private readonly attackLogicResultScratch: AttackLogicResult = {
    attackerTroopLoss: 0,
    defenderTroopLoss: 0,
    tickFraction: 0,
  };

  // Values that are constant for the duration of one tick. The defender's
  // troop count and tile count still change per conquered tile, but its type,
  // traitor/disconnected flags and the fallout ratio do not.
  private tickDefenderType: PlayerType = PlayerType.Bot;
  private tickDefenderIsTraitor = false;
  private tickDefenderIsDisconnectedTeammate = false;
  // undefined = not computed yet this tick.
  private tickFalloutRatio: number | undefined = undefined;

  constructor(
    private startTroops: number | null = null,
    private _owner: Player,
    private _targetID: PlayerID | null,
    private sourceTile: TileRef | null = null,
    private removeTroops: boolean = true,
  ) {}

  public targetID(): PlayerID | null {
    return this._targetID;
  }

  /** B2: capture the attack march state (border heap + PRNG + link to Attack). */
  checkpoint(): ExecutionCheckpoint {
    const target = this.target as Player | TerraNullius | undefined;
    // Another AttackExecution can merge or delete this attack during its init
    // (see the outgoing/incoming merge loops below); this execution keeps the
    // now-inactive reference until its next tick notices and deactivates.
    // `this.attack === null` means the execution is still pending its first
    // init, so leave `active` alone there.
    const hasLiveAttack = this.attack !== null && this.attack.isActive();
    const active =
      this.attack === null ? this.active : this.active && hasLiveAttack;
    return {
      kind: "attack",
      data: {
        startTroops: this.startTroops,
        ownerId: this._owner.id(),
        targetId:
          target === undefined
            ? this._targetID
            : target.isPlayer()
              ? (target as Player).id()
              : null,
        sourceTile: this.sourceTile,
        removeTroops: this.removeTroops,
        active,
        random: this.random.state(),
        attackId: hasLiveAttack ? this.attack!.id() : null,
        toConquer: this.toConquer.snapshot(),
      } satisfies AttackExecutionCheckpoint,
    };
  }

  /**
   * B2: overwrite this execution from a checkpoint. The `Attack` it drives was
   * already rebuilt by `GameImpl.restoreFromCheckpoint`; here we re-link to it.
   * Returns false when the linked attack is missing (fail-safe).
   */
  restoreCheckpoint(game: Game, data: AttackExecutionCheckpoint): boolean {
    this.active = data.active;
    this.random.setState(data.random);
    this.toConquer.restore(data.toConquer);
    this.mg = game;
    this.map = game.map();
    this.target =
      data.targetId === null ? game.terraNullius() : game.player(data.targetId);
    this.ownerSmallID = this._owner.smallID();
    this.targetSmallID = this.target.smallID();
    this.defenseLevelCache.clear();
    // Seed the coverage signature from the restored posts. When the checkpoint
    // predates tier capture (`tiers` absent) but posts exist, leave it null so
    // the first tick re-tiers the heap from live coverage.
    const signature = this.computeDefensePostSignature();
    this.defensePostSignature =
      signature !== "" && data.toConquer.tiers === undefined ? null : signature;
    if (data.attackId === null) {
      this.attack = null;
    } else {
      this.attack =
        this._owner
          .outgoingAttacks()
          .find((attack) => attack.id() === data.attackId) ?? null;
      if (this.attack === null) return false;
    }
    return true;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  /**
   * Highest defense-post level the defender has in range of `tile`, matching
   * the coverage test used by `Config.attackLogic` (active, not under
   * construction). 0 means undefended. Cached per tick.
   */
  private defenseLevelAt(tile: TileRef): number {
    const target = this.target;
    if (target === undefined || !target.isPlayer()) return 0;

    const defender = target as Player;
    // Fast path: a defender with no defense posts cannot defend any tile.
    // unitCount() sums levels, so it is 0 exactly when they own none. Return
    // before touching the cache: most attacks have an undefended defender, and
    // caching a 0 for every queried tile grew the map to the whole frontier.
    if (defender.unitCount(UnitType.DefensePost) === 0) {
      return 0;
    }

    const cached = this.defenseLevelCache.get(tile);
    if (cached !== undefined) return cached;

    const level = this.mg.highestLevelNearby(
      tile,
      this.mg.config().defensePostRange(),
      UnitType.DefensePost,
      defender.id(),
    );
    this.defenseLevelCache.set(tile, level);
    return level;
  }

  /**
   * Deterministic signature of the defender's defense posts. It changes when a
   * post is built, completes construction, is upgraded, destroyed or captured,
   * which is exactly when the frontier's defense tiers may need refreshing.
   */
  private computeDefensePostSignature(): string {
    const target = this.target;
    if (target === undefined || !target.isPlayer()) return "";
    const posts = (target as Player).units(UnitType.DefensePost);
    if (posts.length === 0) return "";
    posts.sort((a, b) => a.id() - b.id());
    let signature = "";
    for (const post of posts) {
      signature += `${post.id()}:${post.level()}:${
        post.isUnderConstruction() ? 1 : 0
      }:${post.isActive() ? 1 : 0},`;
    }
    return signature;
  }

  /**
   * Clear the per-tick tier cache and re-tier the frontier if the defender's
   * defense-post coverage changed since the previous attack tick.
   */
  private refreshDefenseTiers(): void {
    this.defenseLevelCache.clear();
    const signature = this.computeDefensePostSignature();
    if (signature === this.defensePostSignature) return;
    const previous = this.defensePostSignature;
    this.defensePostSignature = signature;
    // Nothing to re-tier on the very first tick of an attack against a
    // defender with no posts (and no tiered entries to clear).
    if (signature === "" && (previous === null || previous === "")) return;
    this.toConquer.retier((tile) => this.defenseLevelAt(tile));
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;
    this.map = mg.map();

    if (this._targetID !== null && !mg.hasPlayer(this._targetID)) {
      console.warn(`target ${this._targetID} not found`);
      this.active = false;
      return;
    }

    this.target =
      this._targetID === this.mg.terraNullius().id()
        ? mg.terraNullius()
        : mg.player(this._targetID);
    this.ownerSmallID = this._owner.smallID();
    this.targetSmallID = this.target.smallID();

    if (this._owner === this.target) {
      console.error(`Player ${this._owner} cannot attack itself`);
      this.active = false;
      return;
    }

    // ALLIANCE CHECK — block attacks on friendly (ally or same team)
    if (this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (this._owner.isFriendly(targetPlayer)) {
        console.warn(
          `${this._owner.displayName()} cannot attack ${targetPlayer.displayName()} because they are friendly (allied or same team)`,
        );
        this.active = false;
        return;
      }
    }

    if (this.target && this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (
        targetPlayer.type() !== PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        // Don't let bots embargo since they can't trade anyway.
        targetPlayer.addEmbargo(this._owner, true);
        this.rejectIncomingAllianceRequests(targetPlayer);
      }
    }

    if (this.target.isPlayer() && !this._owner.canAttackPlayer(this.target)) {
      this.active = false;
      return;
    }

    this.startTroops ??= this.mg
      .config()
      .attackAmount(this._owner, this.target);
    if (this.removeTroops) {
      this.startTroops = Math.min(this._owner.troops(), this.startTroops);
      // Take the amount that was actually deducted, not the amount asked for.
      // removeTroops() floors, so a fractional request leaves the attack
      // holding troops the owner never paid for — and retreat refunds the
      // combined total, turning the leftover fractions into free troops.
      this.startTroops = this._owner.removeTroops(this.startTroops);
    }
    this.attack = this._owner.createAttack(
      this.target,
      this.startTroops,
      this.sourceTile,
      new Set<TileRef>(),
    );

    if (this.sourceTile !== null) {
      this.addNeighbors(this.sourceTile);
    } else {
      this.refreshToConquer();
    }

    // Record stats
    this.mg.stats().attack(this._owner, this.target, this.startTroops);

    for (const incoming of this._owner.incomingAttacks()) {
      if (incoming.attacker() === this.target) {
        // Target has opposing attack, cancel them out
        if (incoming.troops() > this.attack.troops()) {
          incoming.setTroops(incoming.troops() - this.attack.troops());
          this.attack.delete();
          this.active = false;
          return;
        } else {
          this.attack.setTroops(this.attack.troops() - incoming.troops());
          incoming.delete();
        }
      }
    }
    for (const outgoing of this._owner.outgoingAttacks()) {
      if (
        outgoing !== this.attack &&
        outgoing.target() === this.attack.target() &&
        // Boat attacks (sourceTile is not null) are not combined with other attacks
        this.attack.sourceTile() === null
      ) {
        this.attack.setTroops(this.attack.troops() + outgoing.troops());
        outgoing.delete();
      }
    }

    // Nothing next to the owner to conquer (no wilderness around them, or a
    // target they don't border): the attack doesn't happen. Held until the
    // next tick, the troops would sit out the regen step and come back free,
    // so one such attack per tick kept regen at its peak rate and refunded
    // past maxTroops.
    if (this.toConquer.size() === 0) {
      this.retreat();
      return;
    }

    if (this.target.isPlayer()) {
      const difficulty = this.mg.config().gameConfig().difficulty;
      let relationChange: number;
      switch (difficulty) {
        case Difficulty.Easy:
          relationChange = -60;
          break;
        case Difficulty.Medium:
          relationChange = -70;
          break;
        case Difficulty.Hard:
          relationChange = -80;
          break;
        case Difficulty.Impossible:
          relationChange = -100;
          break;
        default:
          assertNever(difficulty);
      }
      this.target.updateRelation(this._owner, relationChange);
    }
  }

  private refreshToConquer() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.toConquer.clear();
    this.attack.clearBorder();
    // forEach over the dense storage — the values() generator showed up in long-game profiles
    this._owner.borderTiles().forEach((tile) => this.addNeighbors(tile));
  }

  private retreat() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    if (this.removeTroops === false && this.sourceTile === null) {
      // startTroops are always added to attack troops at init but not always removed from owner troops
      // subtract startTroops from attack troops so we don't give back startTroops to owner that were never removed
      // boat attacks (sourceTile !== null) are the exception: troops were removed at departure and must be returned after attack still
      this.attack.setTroops(this.attack.troops() - (this.startTroops ?? 0));
    }

    const survivors = this.attack.troops();
    this._owner.addTroops(survivors);
    this.attack.delete();
    this.active = false;

    // Not all retreats are canceled attacks
    if (this.attack.retreated()) {
      // Record stats
      this.mg.stats().attackCancel(this._owner, this.target, survivors);
    }
  }

  tick(ticks: number) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }
    let troopCount = this.attack.troops(); // cache troop count
    const targetIsPlayer = this.target.isPlayer(); // cache target type
    const targetPlayer = targetIsPlayer ? (this.target as Player) : null; // cache target player

    if (this.attack.retreated()) {
      // Retreating refunds all surviving troops: no troop-cost penalty.
      this.retreat();
      this.active = false;
      return;
    }

    if (this.attack.retreating()) {
      return;
    }

    if (!this.attack.isActive()) {
      this.active = false;
      return;
    }

    if (targetPlayer && this._owner.isFriendly(targetPlayer)) {
      // In this case a new alliance was created AFTER the attack started.
      this.retreat();
      return;
    }

    // Defense posts do not move, but they can be built, upgraded, destroyed or
    // captured between ticks. Re-tier the frontier before conquering so the
    // heap always reflects current coverage.
    this.refreshDefenseTiers();

    this.refreshTickCaches(targetPlayer);

    const config = this.mg.config();
    const map = this.map;
    const borderSize = this.attack.borderSize() + this.random.nextInt(0, 5);
    // Each tile consumes a fraction of the tick; conquer until it is spent.
    let tickBudget = 1;

    while (tickBudget > 0) {
      if (troopCount < 1) {
        this.attack.delete();
        this.active = false;
        return;
      }

      if (this.toConquer.size() === 0) {
        this.refreshToConquer();
        this.retreat();
        return;
      }

      const tileToConquer = this.toConquer.dequeue();
      this.attack.removeBorderTile(tileToConquer);

      // A tile the player excluded from conquest is skipped outright — it was
      // already filtered out of addNeighbors, but this also covers tiles
      // excluded after they were enqueued.
      if (this._owner.isAvoidedTile(tileToConquer)) {
        continue;
      }

      let onBorder = false;
      const numNeighbors = map.neighbors4(tileToConquer, this.nbuf);
      for (let i = 0; i < numNeighbors; i++) {
        if (map.ownerID(this.nbuf[i]) === this.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (map.ownerID(tileToConquer) !== this.targetSmallID || !onBorder) {
        continue;
      }
      if (!map.isLand(tileToConquer) || map.isImpassable(tileToConquer)) {
        continue;
      }
      this.addNeighbors(tileToConquer);
      const { attackerTroopLoss, defenderTroopLoss, tickFraction } =
        config.attackLogic(
          this.attackLogicInput(troopCount, tileToConquer, borderSize),
          this.attackLogicResultScratch,
        );
      tickBudget -= tickFraction;
      troopCount -= attackerTroopLoss;
      this.attack.setTroops(troopCount);
      if (targetPlayer) {
        targetPlayer.removeTroops(defenderTroopLoss);
      }
      this._owner.conquer(tileToConquer);
      this.handleDeadDefender();
    }
  }

  /**
   * Snapshot the values that cannot change while this execution conquers
   * tiles. The defender's troops/tiles do change, so those stay live reads.
   */
  private refreshTickCaches(targetPlayer: Player | null): void {
    this.tickFalloutRatio = undefined;
    if (targetPlayer === null) return;
    this.tickDefenderType = targetPlayer.type();
    this.tickDefenderIsTraitor = targetPlayer.isTraitor();
    this.tickDefenderIsDisconnectedTeammate =
      targetPlayer.isDisconnected() && this._owner.isOnSameTeam(targetPlayer);
  }

  private falloutRatioForTick(): number {
    let ratio = this.tickFalloutRatio;
    if (ratio === undefined) {
      const withFallout = this.mg.numTilesWithFallout();
      ratio = withFallout > 0 ? withFallout / this.mg.numLandTiles() : 0;
      this.tickFalloutRatio = ratio;
    }
    return ratio;
  }

  private attackLogicInput(
    attackTroops: number,
    tile: TileRef,
    borderSize: number,
  ): AttackLogicInput {
    const input = this.attackLogicInputScratch;
    const hasDefender = this.target.isPlayer();
    input.terrain = this.map.terrainType(tile);
    input.attackTroops = attackTroops;
    input.attacker.type = this._owner.type();
    input.attacker.numTiles = this._owner.numTilesOwned();
    // Same test as scanning nearbyUnits() for a post owned by the defender
    // (active, not under construction, within range), without building a
    // result array per conquered tile — this runs for every tile of every
    // attack on the map. Uses the highest-level post in range. The value is
    // cached for the tick so the conquest ordering and the combat formula
    // agree.
    input.defensePostLevel = hasDefender ? this.defenseLevelAt(tile) : 0;
    input.falloutRatio = this.mg.hasFallout(tile)
      ? this.falloutRatioForTick()
      : null;
    input.borderSize = borderSize;

    if (!hasDefender) {
      input.defender = null;
    } else {
      const defender = this.target as Player;
      const d = this.defenderScratch;
      d.type = this.tickDefenderType;
      d.numTiles = defender.numTilesOwned();
      d.troops = defender.troops();
      d.isTraitor = this.tickDefenderIsTraitor;
      d.isDisconnectedTeammate = this.tickDefenderIsDisconnectedTeammate;
      input.defender = d;
    }
    return input;
  }

  private rejectIncomingAllianceRequests(target: Player) {
    const request = this._owner
      .incomingAllianceRequests()
      .find((ar) => ar.requestor() === target);
    if (request !== undefined) {
      request.reject();
    }
  }

  private addNeighbors(tile: TileRef) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const tickNow = this.mg.ticks(); // cache tick

    const numNeighbors = this.map.neighbors4(tile, this.nbuf);
    for (let i = 0; i < numNeighbors; i++) {
      const neighbor = this.nbuf[i];
      if (
        this.map.isWater(neighbor) ||
        this.map.isImpassable(neighbor) ||
        this.map.ownerID(neighbor) !== this.targetSmallID ||
        this._owner.isAvoidedTile(neighbor)
      ) {
        continue;
      }
      this.attack.addBorderTile(neighbor);
      let numOwnedByMe = 0;
      const numInner = this.map.neighbors4(neighbor, this.nbuf2);
      for (let j = 0; j < numInner; j++) {
        if (this.map.ownerID(this.nbuf2[j]) === this.ownerSmallID) {
          numOwnedByMe++;
        }
      }

      let mag: number;
      switch (this.map.terrainType(neighbor)) {
        case TerrainType.Plains:
          mag = 1;
          break;
        case TerrainType.Highland:
          mag = 1.5;
          break;
        case TerrainType.Mountain:
          mag = 2;
          break;
        default:
          mag = 0;
          break;
      }

      const priority =
        (this.random.nextInt(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) +
        tickNow;

      // Undefended tiles (tier 0) are conquered before defended ones; among
      // defended tiles, lower defense-post levels come first.
      this.toConquer.enqueue(neighbor, priority, this.defenseLevelAt(neighbor));
    }
  }

  private handleDeadDefender() {
    if (!(this.target.isPlayer() && this.target.numTilesOwned() < 100)) return;
    const target: Player = this.target;
    // The first conquest below 100 tiles redistributes the whole remaining
    // territory, so every later conquered tile in the same tick would call
    // conquerPlayer again on an already-eliminated player. That repeated work
    // (messages, stats, tile scans) showed up in long-game profiles.
    if (target.numTilesOwned() === 0) return;

    this.mg.conquerPlayer(this._owner, target);

    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let progressed = false;
      // Ascending ref order so the outcome does not depend on the tile set's
      // iteration order, which a checkpoint restore rebuilds (see
      // GameImpl.rebuildPlayerTiles). Skip refs conquered earlier this pass.
      const owned = Array.from(target.tiles());
      owned.sort((a, b) => a - b);
      for (const tile of owned) {
        if (!target.tiles().has(tile)) continue;
        let borders = false;
        this.mg.forEachNeighbor(tile, (t) => {
          if (!borders && this.mg.owner(t) === this._owner) {
            borders = true;
          }
        });
        if (borders) {
          this._owner.conquer(tile);
          progressed = true;
        } else {
          let captured = false;
          this.mg.forEachNeighbor(tile, (neighbor) => {
            if (captured) return;
            const no = this.mg.owner(neighbor);
            if (no.isPlayer() && no !== target && !no.isFriendly(target)) {
              this.mg.player(no.id()).conquer(tile);
              captured = true;
            }
          });
          if (captured) progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  owner(): Player {
    return this._owner;
  }

  isActive(): boolean {
    return this.active;
  }
}
