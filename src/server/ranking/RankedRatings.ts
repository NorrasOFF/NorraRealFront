import type { Express } from "express";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import type { RankedLeaderboardEntry } from "../../core/ApiSchemas";
import { authDataDir } from "../AuthPaths";

// The single ranked ladder. Games that produce a rating are private lobbies
// whose host listed them publicly ("ranked lobbies"). The computation is
// intentionally isolated behind RatingAlgorithm so the provisional formula
// below can be replaced without touching persistence, the wire or the UI.

export const RANKED_START_ELO = 1200;
export const RANKED_K_FACTOR = 32;
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
}

export interface PlayerRating {
  publicId: string;
  username: string;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  games: number;
  updatedAt: number;
}

/**
 * Pure rating step. Receives the ratings as they stood before the match and
 * returns the new Elo for every participant it wants to change. The store
 * handles persistence, win/loss counters and idempotency.
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
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
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
    wins: 0,
    losses: 0,
    games: 0,
    updatedAt: now,
  };
}

function clampElo(elo: number): number {
  return Math.max(RANKED_MIN_ELO, Math.round(elo * 100) / 100);
}

function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - rating) / 400));
}

/**
 * Provisional, deliberately simple Elo. Winners are compared pairwise against
 * every loser; same-outcome pairs (two teammates or two losers) are skipped so
 * a team result does not inflate or deflate teammates against each other. Each
 * player's swing is averaged over the cross-outcome opponents they faced.
 *
 * Replace this function (or pass another RatingAlgorithm to the store) once
 * the real balancing model is ready. Team games use winnerPublicIds; no team
 * membership beyond the winner set is required by this formula.
 */
export const provisionalElo: RatingAlgorithm = (match, ratings) => {
  const winners = new Set(match.winnerPublicIds);
  const participants = new Map<string, RankedParticipant>();
  for (const p of match.participants) {
    if (!participants.has(p.publicId)) participants.set(p.publicId, p);
  }
  const relevantWinners = [...participants.keys()].filter((id) =>
    winners.has(id),
  );
  const losers = [...participants.keys()].filter((id) => !winners.has(id));
  const updates = new Map<string, number>();
  if (relevantWinners.length === 0 || losers.length === 0) {
    for (const id of participants.keys()) {
      updates.set(id, ratings.get(id)?.elo ?? RANKED_START_ELO);
    }
    return updates;
  }

  const deltas = new Map<string, { total: number; games: number }>();
  const add = (id: string, delta: number) => {
    const entry = deltas.get(id) ?? { total: 0, games: 0 };
    entry.total += delta;
    entry.games += 1;
    deltas.set(id, entry);
  };

  for (const winnerId of relevantWinners) {
    const winnerRating = ratings.get(winnerId)?.elo ?? RANKED_START_ELO;
    for (const loserId of losers) {
      const loserRating = ratings.get(loserId)?.elo ?? RANKED_START_ELO;
      const winnerExpected = expectedScore(winnerRating, loserRating);
      add(winnerId, RANKED_K_FACTOR * (1 - winnerExpected));
      add(loserId, -RANKED_K_FACTOR * winnerExpected);
    }
  }

  for (const id of participants.keys()) {
    const start = ratings.get(id)?.elo ?? RANKED_START_ELO;
    const delta = deltas.get(id);
    updates.set(
      id,
      clampElo(delta === undefined ? start : start + delta.total / delta.games),
    );
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
    private readonly algorithm: RatingAlgorithm = provisionalElo,
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
    return rating === undefined ? null : { ...rating };
  }

  async leaderboard(
    page = 1,
    pageSize = 50,
  ): Promise<RankedLeaderboardEntry[]> {
    await this.init();
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeSize = Math.max(1, Math.min(200, Math.floor(pageSize)));
    const sorted = [...this.players.values()].sort((a, b) => {
      if (b.elo !== a.elo) return b.elo - a.elo;
      return a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0;
    });
    const start = (safePage - 1) * safeSize;
    return sorted.slice(start, start + safeSize).map((rating, index) => ({
      rank: start + index + 1,
      elo: rating.elo,
      peakElo: rating.peakElo,
      wins: rating.wins,
      losses: rating.losses,
      total: rating.games,
      public_id: rating.publicId,
      accountUsername: rating.username,
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
        if (!this.players.has(participant.publicId)) {
          this.players.set(
            participant.publicId,
            defaultRating(participant.publicId, participant.username, now),
          );
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
        if (winners.has(participant.publicId)) rating.wins += 1;
        else rating.losses += 1;
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
// empty array (the client stops paging on a short page).
export function registerRankedRoutes(app: Express): void {
  app.get("/api/leaderboard/ranked", async (req, res) => {
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
