# Handoff — placement-based ranked rating with inactivity decay

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Token `H:\Documents\Hexfront-token.txt` authenticates as **`hexfront-dev`**
  and can push to the fork.
- Remotes: `origin` = `hexfront-dev/NorraRealFront-Remus-` (ship target
  `origin/main`), `norrasoff` = `NorrasOFF/NorraRealFront`,
  `upstream` = `openfrontio/OpenFrontIO`.
- GitHub credential-manager prompts fail in this shell; push with a
  credential-in-URL remote instead of `http.extraHeader`.

## 2. Exact ranked rating formula (implemented)

```
P = finishing place, 1-indexed, dense over rated accounts (1..N)
T = number of rated teammates sharing P (1 in FFA)
W = RANKED_WINNER_ELO = 100
S = RANKED_PLACEMENT_SLOPE = 0.05

placeAward(P) = max(0, W * (1 - S * (P - 1)))
award(P, T)   = placeAward(P) / T
newElo        = clampElo(oldElo + award(P, T))       // clampElo = min 100, 2 d.p.

P:      1    2    3    4    5    6    7    8    9   10   11   12   13   14   15
award: 100   95   90   85   80   75   70   65   60   55   50   45   40   35   30
```

`placeAward(21) = 0`; larger places are clamped to 0. Teams split one place
award equally: a 2-player team win pays 50 each, a 3-player win 33.33 each.

If the literal `1 - 0.05 * P` is wanted instead (winner 95, 15th 25), change
`(P - 1)` to `P` in `placementAward` (`src/server/ranking/RankedRatings.ts`).
The `P - 1` form makes the "winner elo constant" the actual first-place award.

### Inactivity decay

```
excess      = elo - RANKED_START_ELO            // 1200
weeks       = floor((now - lastRatedAt) / 7 days)
decayedElo  = 1200 + max(0, excess) * 0.9 ^ weeks
```

Applied lazily, only for whole weeks:

- `leaderboard()` sorts and returns the decayed value (stored value untouched);
- `player()` returns the decayed value;
- `applyMatch()` decays each returning participant from their stored
  `updatedAt` **before** adding this game's award, then sets
  `updatedAt = now`.

Ratings at/below 1200 never move. Duplicate match uploads return before decay,
so a retried archive cannot decay twice.

### Where places come from

`computeRankedPlacements()` (`src/server/ranking/Placements.ts`) uses the
core's existing stats: eliminated players by `deathPosition`, survivors by
`finalTiles` (winner first). Places are dense over `rankedRoster`, so bots and
nations do not consume places. Teammates share the best place reached by the
team (`teamSize` is recorded for the split). Duplicate accounts collapse to
one entry; deterministic tie-break is `publicId`. A nation winner still leaves
the game unrated (unchanged).

## 3. What changed

- `src/server/ranking/Placements.ts` (new): pure placement resolver + tests.
- `src/server/ranking/RankedRatings.ts`: replaced the provisional pairwise
  `provisionalElo`/`RANKED_K_FACTOR` with `placementElo`; added
  `placementAward`, `decayElo`, `RANKED_WINNER_ELO`,
  `RANKED_PLACEMENT_SLOPE`, `RANKED_IDLE_DECAY_PER_WEEK`, `RANKED_WEEK_MS`;
  `RankedMatch.placements` (optional, for old callers/tests).
- `src/server/GameServer.ts`: `applyRankedResult` now also receives
  `allPlayersStats` and builds placements from the ranked roster.
- `src/server/ranking/ResumeEligibility.ts` (new): derives the alive clientIDs
  from a host checkpoint and the seats a resumed ranked game must reclaim.
- `src/core/Schemas.ts`: `SavedLobbySchema.aliveClientIDs?: string[]`, written
  by `GameServer.snapshot()` only when a started game has an accepted
  checkpoint. It is a JSON save field only; no wire/checkpoint-format change.

### Resumed ranked lobbies

A started save now **keeps** its ranked flag. When the host's resume countdown
actually starts play (`startResumedGame`), the game stays ranked only if every
required seat was reclaimed **by its original account**:

- required seats are the checkpoint's alive human clientIDs
  (`aliveClientIdsFromCheckpoint`: `playerInfo.clientID` without a
  `deathPosition` in `checkpoint.stats`);
- if the save has no checkpoint/alive set (older saves), every non-spectator
  seat is required (stricter fallback);
- a claim counts only when the claimant's `publicId` matches the saved seat's
  (`persistentID` fallback for seats without a publicId), so a different login
  grabbing the seat does not count;
- on any missing required seat the ranked flag is deleted from `gameConfig`
  and `gameStartInfo.config`, `rankedRoster` is cleared, and the game archives
  unrated. Players can still play it for fun.

## 4. Verification

- `npx tsc --noEmit` clean; ESLint, Oxlint and Prettier clean.
- `tests/server/RankedRatings.test.ts` (19) and
  `tests/server/RankedPlacements.test.ts` pass, including team split, fallback
  placements, decay-before-award and decayed leaderboard ordering.
- `tests/server/RankedLobby.test.ts` 5 pass, including a stats-driven
  placement integration case.
- `tests/server/RankedResumeEligibility.test.ts` and the `ranked resume
eligibility` block in `tests/server/GameServerSave.test.ts` cover all-rejoined,
  missing-survivor, wrong-account, no-alive-set fallback and snapshot handoff.
- `npx vitest run tests/server tests/zbin`: **866 passed, 3 failed** — the three
  failures are the documented pre-existing ones (`GameServerWire` `numTurns`
  snapshot, `HostedLobbyListing`, `GameServerPhase`). No new failures.
- Not browser-tested: server-only changes, no UI/input/wire path touched.

## 5. Open items

- **Tuning**: `RANKED_WINNER_ELO = 100` is a first guess; revisit after a few
  months of weekly lobbies.
- **Decay is soft, not a hard cap**: a long win streak can still lead for a few
  weeks (roughly `0.58 * streak` missed lobbies without decay). An eligibility
  window (e.g. last 21 days) was deliberately not added.
- **Team split semantics**: a team's total is one place award, so per-player
  value falls with team size. If teams should instead sum/average individual
  places, change `Placements.ts` + `placementElo`.
- **Deploy required** for the new formula/decay to run in production. Existing
  `ranked-ratings.json` is compatible; the first match after deploy applies
  decay from each player's stored `updatedAt`.
- **Resume gating limits**: the alive set comes from the latest accepted host
  checkpoint, which can be older than the save, so a player who died after that
  checkpoint is still required to rejoin (stricter, never more permissive). A
  save with no checkpoint requires every non-spectator seat. There is no client
  UI explaining that a resume lost its ranked status; the server log line
  `resumed ranked game is unranked: players did not rejoin` is the only signal.
- **Leaderboard ties**: equal effective Elo sorts by `publicId` ascending, and
  the client shows the first five rows of page 1. Tied players at the five-row
  cutoff are therefore chosen by opaque account id. Change the comparator in
  `RankedRatingsStore.leaderboard()` if a fairer tie-break is wanted (e.g. more
  games first, then recent activity).
- The leaderboard endpoint still returns `elo`; hiding it in the UI is a
  separate client change.
