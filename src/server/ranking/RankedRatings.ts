import type { Express } from "express";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import type { RankedLeaderboardEntry } from "../../core/ApiSchemas";
import { authDataDir } from "../AuthPaths";
import { gameApiCors } from "../GameApiCors";
import type { RankedPlacement } from "./Placements";

// The single ranked ladder. Games that produce a rating are private lobbies
// whose host listed them publicly ("ranked lobbies"). The computation is
// intentionally isolated behind RatingAlgorithm so the formula can be retuned
// without touching persistence, the wire or the UI.

export const RANKED_START_ELO = 1200;
// Elo awarded to the winner of a full lobby. Every place below first loses
// RANKED_PLACEMENT_SLOPE * this amount, so 15th in a 15-player lobby earns
// 100 * (1 - 0.05 * 14) = 30. Teams divide the place award by their size.
export const RANKED_WINNER_ELO = 100;
export const RANKED_PLACEMENT_SLOPE = 0.05;
// Lazy inactivity decay: after each full week without a rated game, the part
// of the rating above RANKED_START_ELO is multiplied by (1 - 0.1) = 0.9.
export const RANKED_IDLE_DECAY_PER_WEEK = 0.1;
export const RANKED_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const RANKED_MIN_ELO = 100;
// Older match ids are forgotten once the log grows past this. They only exist
// to make a retried archive upload idempotent.
const MAX_APPLIED_MATCHES = 1000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

export interface RankedParticipant {
  publicId: string;
  username: string;
}

export interface RankedMatch {
  gameId: string;
  participants: RankedParticipant[];
  // Public ids of the winning player (FFA/1v1) or every member of the winning
  // team (team games). Empty means no winner, and the match is not rated.
  winnerPublicIds: string[];
  // Dense finishing places from the game's stats (see Placements.ts). When
  // omitted the fallback is winner = 1st and everyone else in join order.
  placements?: RankedPlacement[];
}

export interface PlayerRating {
  publicId: string;
  username: string;
  elo: number;
  peakElo: number;
  games: number;
  updatedAt: number;
}

/**
 * Pure rating step. Receives the ratings as they stood before the match and
 * returns the new Elo for every participant it wants to change. The store
 * handles persistence, match counting and idempotency.
 */
export type RatingAlgorithm = (
  match: RankedMatch,
  ratings: ReadonlyMap<string, PlayerRating>,
) => Map<string, number>;

const PlayerRatingSchema = z.object({
  publicId: z.string(),
  username: z.string(),
  elo: z.number(),
  peakElo: z.number(),
  games: z.number().int().nonnegative(),
  updatedAt: z.number(),
});

const RankedRatingsFileSchema = z.object({
  version: z.literal(1),
  players: z.record(z.string(), PlayerRatingSchema),
  appliedMatches: z.array(z.string()),
});

type RankedRatingsFile = z.infer<typeof RankedRatingsFileSchema>;

function defaultRating(
  publicId: string,
  username: string,
  now = Date.now(),
): PlayerRating {
  return {
    publicId,
    username,
    elo: RANKED_START_ELO,
    peakElo: RANKED_START_ELO,
    games: 0,
    updatedAt: now,
  };
}

function clampElo(elo: number): number {
  return Math.max(RANKED_MIN_ELO, Math.round(elo * 100) / 100);
}

/**
 * Placement award before any team split: `RANKED_WINNER_ELO * (1 - slope *
 * (place - 1))`, clamped at zero. First place therefore receives the full
 * winner constant, second 95 at the current tuning, and 15th 30.
 */
export function placementAward(place: number): number {
  const safePlace = Number.isFinite(place) ? Math.max(1, Math.floor(place)) : 1;
  const raw =
    RANKED_WINNER_ELO * (1 - RANKED_PLACEMENT_SLOPE * (safePlace - 1));
  return Math.max(0, Math.round(raw * 100) / 100);
}

/**
 * Lazy inactivity decay. Only whole weeks count, the decay is applied to the
 * part of the rating above RANKED_START_ELO, and a rating at or below the
 * start value never moves. The stored value is updated when the player next
 * finishes a rated game; reads use this same function.
 */
export function decayElo(
  elo: number,
  lastRatedAt: number,
  now: number,
): number {
  const excess = elo - RANKED_START_ELO;
  if (excess <= 0 || !Number.isFinite(lastRatedAt) || now <= lastRatedAt) {
    return elo;
  }
  const weeks = Math.floor((now - lastRatedAt) / RANKED_WEEK_MS);
  if (weeks <= 0) return elo;
  return clampElo(
    RANKED_START_ELO + excess * Math.pow(1 - RANKED_IDLE_DECAY_PER_WEEK, weeks),
  );
}

interface ResolvedPlace {
  place: number;
  teamSize: number;
}

// Places supplied by the game win; anything the caller omitted is treated as
// last. With no placements at all, fall back to winner = 1st and the rest in
// join order so older callers/tests still rate a match.
function resolvePlaces(
  match: RankedMatch,
  participants: Map<string, RankedParticipant>,
): Map<string, ResolvedPlace> {
  const resolved = new Map<string, ResolvedPlace>();
  for (const placement of match.placements ?? []) {
    if (!participants.has(placement.publicId)) continue;
    if (!Number.isFinite(placement.place) || placement.place < 1) continue;
    resolved.set(placement.publicId, {
      place: Math.floor(placement.place),
      teamSize: Math.max(1, Math.floor(placement.teamSize ?? 1)),
    });
  }

  if (resolved.size > 0) {
    const lastPlace = participants.size;
    for (const id of participants.keys()) {
      if (!resolved.has(id))
        resolved.set(id, { place: lastPlace, teamSize: 1 });
    }
    return resolved;
  }

  const winners = new Set(match.winnerPublicIds);
  let nextPlace = 2;
  for (const id of participants.keys()) {
    if (winners.has(id)) {
      resolved.set(id, { place: 1, teamSize: 1 });
    } else {
      resolved.set(id, { place: nextPlace++, teamSize: 1 });
    }
  }
  return resolved;
}

/**
 * Placement-based ranked points. Every finisher gains something (the ladder
 * is deliberately positive-sum so attendance matters), the award falls by
 * 5% of the winner constant per place, and a team splits its place award
 * evenly between its members.
 *
 * There is no pairwise opponent-rating term: the outcome is fully determined
 * by finishing place, so a hidden ladder is stable and easy to explain.
 */
export const placementElo: RatingAlgorithm = (match, ratings) => {
  const participants = new Map<string, RankedParticipant>();
  for (const participant of match.participants) {
    if (!participants.has(participant.publicId)) {
      participants.set(participant.publicId, participant);
    }
  }

  const places = resolvePlaces(match, participants);
  const updates = new Map<string, number>();
  for (const id of participants.keys()) {
    const start = ratings.get(id)?.elo ?? RANKED_START_ELO;
    const resolved = places.get(id);
    const award =
      resolved === undefined
        ? 0
        : placementAward(resolved.place) / resolved.teamSize;
    updates.set(id, clampElo(start + award));
  }
  return updates;
};

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const started = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // The holder released it between open() and stat(); retry immediately.
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        // ES2020 target: the Error `cause` option (ES2022) is unavailable.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("ranked ratings: timed out waiting for the store lock");
      }
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS),
      );
    }
  }
}

export class RankedRatingsStore {
  private players = new Map<string, PlayerRating>();
  private appliedMatches: string[] = [];
  private loaded = false;

  constructor(
    private readonly dir: string = authDataDir(),
    private readonly algorithm: RatingAlgorithm = placementElo,
  ) {}

  private get file(): string {
    return path.join(this.dir, "ranked-ratings.json");
  }

  private get lockFile(): string {
    return `${this.file}.lock`;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = RankedRatingsFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(
          `invalid ranked ratings file: ${z.prettifyError(parsed.error)}`,
        );
      }
      this.applySnapshot(parsed.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.players = new Map();
      this.appliedMatches = [];
    }
    this.loaded = true;
  }

  private applySnapshot(snapshot: RankedRatingsFile): void {
    this.players = new Map(
      Object.entries(snapshot.players).map(([id, rating]) => [
        id,
        { ...rating },
      ]),
    );
    this.appliedMatches = [...snapshot.appliedMatches];
  }

  async init(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const snapshot: RankedRatingsFile = {
      version: 1,
      players: Object.fromEntries(this.players),
      appliedMatches: this.appliedMatches,
    };
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async player(publicId: string): Promise<PlayerRating | null> {
    await this.init();
    const rating = this.players.get(publicId);
    if (rating === undefined) return null;
    return {
      ...rating,
      elo: decayElo(rating.elo, rating.updatedAt, Date.now()),
    };
  }

  async leaderboard(
    page = 1,
    pageSize = 50,
  ): Promise<RankedLeaderboardEntry[]> {
    await this.init();
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeSize = Math.max(1, Math.min(200, Math.floor(pageSize)));
    const now = Date.now();
    // Decay is lazy: the stored value is only rewritten when the player next
    // plays. Sorting and display use the same effective value so a returning
    // player cannot appear at a stale peak.
    const sorted = [...this.players.values()]
      .map((rating) => ({
        rating,
        elo: decayElo(rating.elo, rating.updatedAt, now),
      }))
      .sort((a, b) => {
        if (b.elo !== a.elo) return b.elo - a.elo;
        return a.rating.publicId < b.rating.publicId
          ? -1
          : a.rating.publicId > b.rating.publicId
            ? 1
            : 0;
      });
    const start = (safePage - 1) * safeSize;
    return sorted.slice(start, start + safeSize).map((entry, index) => ({
      rank: start + index + 1,
      elo: entry.elo,
      peakElo: entry.rating.peakElo,
      total: entry.rating.games,
      public_id: entry.rating.publicId,
      accountUsername: entry.rating.username,
    }));
  }

  /**
   * Apply one finished ranked match. Idempotent by game id, and safe across
   * workers because the read-modify-write runs under a shared lock file.
   * Returns true when a rating update was written.
   */
  async applyMatch(match: RankedMatch): Promise<boolean> {
    const unique = new Map<string, RankedParticipant>();
    for (const participant of match.participants) {
      if (participant.publicId.length > 0) {
        unique.set(participant.publicId, participant);
      }
    }
    if (unique.size < 2) return false;
    const winners = new Set(match.winnerPublicIds);
    if (![...winners].some((id) => unique.has(id))) return false;

    await this.init();
    const release = await acquireFileLock(this.lockFile);
    try {
      await this.reload();
      if (this.appliedMatches.includes(match.gameId)) return false;

      const now = Date.now();
      for (const participant of unique.values()) {
        const existing = this.players.get(participant.publicId);
        if (existing === undefined) {
          this.players.set(
            participant.publicId,
            defaultRating(participant.publicId, participant.username, now),
          );
        } else {
          // Apply every full week of inactivity before this game's award, so
          // a returning player is rated from their decayed value. Duplicate
          // uploads return above, before this can run twice.
          existing.elo = decayElo(existing.elo, existing.updatedAt, now);
        }
      }

      const snapshot = new Map(
        [...this.players].map(([id, rating]) => [id, { ...rating }]),
      );
      const nextElos = this.algorithm(match, snapshot);

      for (const participant of unique.values()) {
        const rating = this.players.get(participant.publicId)!;
        const nextElo = nextElos.get(participant.publicId);
        if (nextElo !== undefined) rating.elo = clampElo(nextElo);
        rating.peakElo = Math.max(rating.peakElo, rating.elo);
        if (participant.username.length > 0) {
          rating.username = participant.username;
        }
        rating.games += 1;
        rating.updatedAt = now;
      }

      this.appliedMatches.push(match.gameId);
      if (this.appliedMatches.length > MAX_APPLIED_MATCHES) {
        this.appliedMatches.splice(
          0,
          this.appliedMatches.length - MAX_APPLIED_MATCHES,
        );
      }
      await this.persist();
      return true;
    } finally {
      await release();
    }
  }
}

let singleton: RankedRatingsStore | null = null;

export function getRankedRatings(): RankedRatingsStore {
  singleton ??= new RankedRatingsStore();
  return singleton;
}

export function resetRankedRatingsForTests(): void {
  singleton = null;
}

const LEADERBOARD_PAGE_SIZE = 50;

// GET /api/leaderboard/ranked?page=N
// The single ranked ladder. Pages are 1-based; an out-of-range page is an
// empty array (the client stops paging on a short page). This route is public
// and is also read cross-origin by the Norra Real website's Topplista page, so
// it carries the game API's CORS grant.
export function registerRankedRoutes(app: Express): void {
  app.get("/api/leaderboard/ranked", gameApiCors, async (req, res) => {
    const raw = Array.isArray(req.query.page)
      ? req.query.page[0]
      : req.query.page;
    const page = typeof raw === "string" ? Number.parseInt(raw, 10) : 1;
    try {
      const entries = await getRankedRatings().leaderboard(
        Number.isFinite(page) ? page : 1,
        LEADERBOARD_PAGE_SIZE,
      );
      res.json(entries);
    } catch (error) {
      console.error("ranked leaderboard read failed", error);
      res.status(503).json({ error: "ranked_leaderboard_unavailable" });
    }
  });
}
