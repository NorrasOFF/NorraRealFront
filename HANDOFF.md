# Handoff — ranked lobbies and the single ranked ladder

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Tokens (all authenticate as **`hexfront-dev`**):
  - `H:\Documents\Hexfront-token.txt` — write to the fork (`origin`).
  - `H:\Documents\Norrasoff-token.txt` — read-only on NorrasOFF.
  - `H:\Documents\Fly.io-token.txt` — Fly deploy token (app `openfrontio`).
- Remotes: `origin` = `hexfront-dev/NorraRealFront-Remus-`,
  `norrasoff` = `NorrasOFF/NorraRealFront`, `upstream` = `openfrontio/OpenFrontIO`,
  `hexfront` = `hexfront-dev/OpenFrontIO`.
- Ship target is **`origin/main`**. This session's base branch was
  `upstream-v34-backports`.

## 2. What landed this session

The old 1v1/2v2 matchmaking entry point is gone from the home menu. A private
lobby that its host lists publicly is now a **ranked lobby**, and every ranked
lobby feeds **one** Elo ladder instead of two.

### Ranked lobby model and gating

- `GameConfig.ranked?: boolean` (`src/core/Schemas.ts`) is server-authoritative.
  It is **not** in `ConfigPatch.ts`, so hosts cannot set it through
  `update_game_config` or a crafted `create_game`.
- `GameServer.setListed(true)` stamps `ranked = true`; a server-side delist
  before start deletes it. `start()` copies the listing state into the frozen
  `GameStartInfo.config`. A resumed save always clears `ranked` (continuation,
  never re-rated).
- Joining a ranked lobby requires a signed-in account:
  `GameServer.passesRankedSignIn()` uses `client.publicId` (only set for JWT
  joins) and returns a new `not_authenticated` join result. The Worker closes
  with `Sign in to join ranked lobbies`.
- The listing endpoint (`POST /api/game/:id/listing`) also rejects the anonymous
  dev persistent-ID path (`sign_in_required`) so a host cannot list a lobby it
  could not itself join.
- `tests/server/RankedLobby.test.ts` covers the marker, the signed-in gate and
  the game-end hook.

### One ladder, local ratings store

New module `src/server/ranking/RankedRatings.ts`:

- JSON store at `AUTH_DIR/ranked-ratings.json` (same directory as
  `accounts.json`/`jwt-key.json`; path helper in `src/server/AuthPaths.ts`).
- Stores `elo`, `peakElo`, wins/losses/games per account, plus recent game ids
  for idempotent re-uploads. Cross-worker read-modify-write is serialised with
  a lock file; writes are atomic temp-file + rename.
- `provisionalElo` is a **placeholder** standard-Elo implementation. Replace it
  (or pass another `RatingAlgorithm` to the store) when the real balancing model
  is ready. The store, endpoint, UI and game hook do not need to change.
- `GameServer` snapshots account identities for a ranked lobby at start
  (`rankedRoster`) and, on game end, maps the winner tuple to public ids and
  calls `deps.ranked(...)`. Team wins use the winner tuple's trailing client
  ids. A nation winner is not rated.
- `GET /api/leaderboard/ranked?page=N` (Master) returns one flat page of 50
  `RankedLeaderboardEntry` values.
- `LocalAuth.userMeFromToken` now adds `player.leaderboard.ranked.elo` when the
  account has a rating.
- `tests/server/RankedRatings.test.ts` covers Elo, idempotency, persistence,
  ordering, paging and the replaceable algorithm.

### Client

- The home menu no longer has the Ranked button or the `#modal=ranked` route.
  `RankedModal.ts`/`Matchmaking.ts` still exist for a future matchmaking design
  but are no longer imported or reachable (their tests still pass). Server
  matchmaking code (`MapPlaylist` 1v1/2v2 configs, Worker polling, team pins) is
  untouched.
- `LeaderboardModal` has one player tab ("Ranked") plus Clans and Tribes.
  `LeaderboardPlayerList` is now a single flat list (paging by 50).
- `RankedLeaderboardResponseSchema` is a flat array; `UserMeResponse` keeps the
  legacy `oneVone`/`twoVtwo` fields optional so the dormant matchmaking client
  still type-checks, and adds `leaderboard.ranked`.
- Host modal: the Public listing segment is labelled **Ranked**; the join modal
  heading is **Ranked Lobbies**; listing error strings now say ranked. The home
  layout keeps Solo full width and compresses the bottom row to the remaining
  three buttons (`grid-cols-3`), with no gap where Ranked used to be.

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npx vitest run tests/server` — **679 passed, 3 failed**, all documented
  pre-existing failures in `testnotes.md`: `MapPlaylistOvertime`,
  `HostedLobbyListing` (no `createGame`), `GameServerWire` golden (`numTurns`,
  plus the known snapshot drift). The snapshot was re-checked: this session no
  longer adds a `ranked: undefined` key (only `ranked: true` is written).
- Targeted tests all pass: `RankedRatings`, `RankedLobby`,
  `ApiPlayerLeaderboard`, `LeaderboardModal`, `GameModeSelectorGating`,
  `EnJsonSorted`, `LocalAuth`, `GameServerSave`, `SpectatorJoin`,
  `MatchmakingCancel`.
- `HostedLobbyListing`'s host-left tests now give their fixture clients
  `publicId`/claims because a listed lobby is ranked; the remaining failure is
  the documented scheduling one.

## 4. Open items

- **Replace `provisionalElo`** with the real algorithm (or wire in the balancing
  model). Nothing else needs to change.
- **Stats/profile integration**: `PlayerStatsTreeSchema` and clan stats still
  have the legacy `Ranked` keyed by `RankedType` (`1v1`/`2v2`). They are not fed
  by the local store; the local `/users/@me` has no stats tree, so the profile
  shows no stats. Migrating those schemas/UI to one ranked bucket is still to do.
- **Game history labels**: archived records now carry `config.ranked`, but the
  public game/player-history schemas still identify ranked games via
  `rankedType`. A ranked-lobby game will therefore not show as “Ranked” in the
  history UI until that schema/API side is updated.
- **Matchmaking**: the client matchmaking code is dormant. Reuse/adapt it for
  the single ladder when a matchmaking design exists.
- **Local ratings storage** is a single JSON file. It is suitable for this
  single-volume Fly deployment; multi-machine deployments need Postgres/Redis
  or shared storage. The lock file is best-effort (`LOCK_STALE_MS = 10s`).
- `GAME_ENV=dev` remains the deployment assumption; local listing is allowed
  through the dev bypass even though `LocalAuth` returns
  `canCreatePublicLobbies: false`. Signed-in users still have `unlimitedRanked`.
- A ranked lobby with a nation winner, or one that ends without a winner, is
  not rated. If those outcomes should affect ratings, the algorithm/store needs
  an explicit policy.
