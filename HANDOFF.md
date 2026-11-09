# Handoff — Points-based ranked team balancing

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`, section "Ranked teams are balanced by ladder
points".

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Token `H:\Documents\Hexfront-token.txt` authenticates as **`hexfront-dev`**.
- Ship target: `origin` = `hexfront-dev/NorraRealFront-Remus-`, branch `main`.
  `main` is at **`2762aafcb`** (feature commit `c4dc284bf` on top of
  `3027aa072`).
- The checked-out branch is `defense-post-priority`, whose tip is `origin/main`;
  local `main` is stale (`2189bf96f`). Push with `git push origin HEAD:main`.
- GitHub credential-manager prompts fail in this shell; push with a
  credential-in-URL remote (`https://x-access-token:<token>@github.com/...`).

## 2. What shipped

Ranked lobbies (listed private lobbies) in **Team** mode now assign each human's
team slot from the ranked ladder so the team point sums are as close as
possible, instead of leaving the split to join order / clan / friend grouping.

- **Points:** the single ranked Elo ladder, effective (decayed) value; unknown
  accounts count as `RANKED_START_ELO` (1200). New
  `rankedPointsFor(publicIds)` in `src/server/ranking/RankedRatings.ts`.
- **Algorithm:** `src/server/ranking/TeamBalancing.ts` (pure). Minimizes
  `max(team sum) - min(team sum)`, tie-break by squared deviation from the
  mean; team sizes are floor/ceil of players/teams. Exact branch and bound for
  rosters ≤ 16 (`EXACT_SPLIT_LIMIT`), greedy + best-improvement local search
  above that. Deterministic (points desc, then clientID).
- **Equal points:** if every player has the same points, **no pins** are
  produced and the normal assignment path runs unchanged (explicit
  requirement; do not "balance" an all-1200 lobby into a fixed split).
- **Skipped:** FFA, `HumansVsNations`, matchmade games (the matcher's
  `matchmakingTeams` wins), and Duos/Trios/Quads with `nations: "default"`
  (the server cannot know the map's nation count).
- **Flow:** `GameServer.refreshRankedTeams()` on listing / join / rejoin;
  `GameManager.startWhenReady()` awaits one final refresh before `start()`.
  A ladder read failure logs `warn` and still starts. A generation counter
  drops stale refreshes.
- **Pins:** stamped through the existing `teamIndex` field
  (`teamIndexFor`), which `assignTeams` already honors and `PlayerRecord`
  already archives — replays stay deterministic and `CHECKPOINT_VERSION` is
  unchanged.
- **Lobby UI:** `ClientInfo.elo` (optional, appended to the lobby-roster schema;
  hidden when `anonymizeNames` is on) is rendered beside each name by
  `LobbyPlayerView`. The existing team preview honors the pins, so the balanced
  teams are visible before the host presses Start.

## 3. Verification

- `npx tsc --noEmit`, `npm run lint`, Prettier clean.
- `tests/server`: 749 passed, only the three documented pre-existing failures
  (`GameServerWire` golden transcript — its diff now also shows
  `elo: undefined`; `HostedLobbyListing`; `GameServerPhase`).
- `tests/core`: 457 passed with the known `SAMLauncherExecution` dynamic-range
  failure. `TranslationSystem` still reports the four documented unused keys.
- New: `tests/server/ranking/TeamBalancing.test.ts` (optimality vs brute force,
  sizes, determinism, 64-player lobby), `tests/server/RankedTeamBalancing.test.ts`
  (start-info pins, equal-points fallback, FFA/unranked/matchmade untouched,
  failure tolerance), `tests/client/LobbyPlayerViewPoints.test.ts` (render).
- **Not browser-tested:** needs a listed lobby with two signed-in accounts in
  two browsers; the single-player e2e harness cannot create that. Server tests
  cover the wire/start payload, the component test covers the render.

## 4. Open items

- **Browser pass:** open a ranked 2-team lobby with two accounts, confirm points
  appear beside names, teams are balanced in the preview, and the same split is
  used after Start.
- **Multi-worker staleness:** `RankedRatingsStore` caches the ladder file per
  process (reloaded by `applyMatch`). Workers that never rate a game may balance
  from slightly stale points until they do. Harmless for now; add a TTL reload
  in `rankedPointsFor`/the store if fairness across many instances matters.
- **Optional polish:** add a one-line lobby hint that ranked team games are
  points-balanced (new `host_modal` key); or apply the same balancer to the
  external 2v2 queue split in `src/server/Worker.ts` if that matcher stops
  balancing (it currently trusts `assignment.teams`).
- **Tuning:** `rankedTeamCount` mirrors `GameImpl.populateTeams`; revisit it if
  the team-count config or nation defaults change.
