# Handoff — ranked points: hidden rating, placement awards, balanced teams

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Token `H:\Documents\Hexfront-token.txt` authenticates as **`hexfront-dev`**.
- Ship target: `origin` = `hexfront-dev/NorraRealFront-Remus-`, branch `main`.
  The checked-out branch is `defense-post-priority`; push with
  `git push origin HEAD:main`.
- GitHub credential-manager prompts fail in this shell; push with a
  credential-in-URL remote (`https://x-access-token:<token>@github.com/...`).

## 2. Ranked rating (current, authoritative)

Everyone starts at **0**, there is **no inactivity decay**, and every rated
game only adds points:

```
P = finishing place (1 = winner), dense over rated accounts
T = number of rated teammates sharing P (1 in FFA)
W = RANKED_WINNER_ELO      = 100
S = RANKED_PLACEMENT_SLOPE = 0.05

placementAward(P, T) = max(0, (W / T) * (1 - S * (P - 1)))
newPoints            = oldPoints + placementAward(P, T)
```

The team division happens **before** the place reduction (that is the requested
order; algebraically it matches dividing the final award, but the code now
expresses it as `(W / T) * factor`). A 2-player team win pays 50 each, 3-player
33.33 each. Solo values:

| Place |   1 |   2 |   3 |   4 |   5 |   6 |   7 |   8 |   9 |  10 |  11 |  12 |  13 |  14 |  15 |
| ----- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| Award | 100 |  95 |  90 |  85 |  80 |  75 |  70 |  65 |  60 |  55 |  50 |  45 |  40 |  35 |  30 |

`placementAward(21)` is 0; larger places clamp to 0.

Places come from `src/server/ranking/Placements.ts`: eliminated players by
`deathPosition`, survivors by `finalTiles` (winner first), dense over the rated
roster so bots/nations do not consume places. Teammates share the best place
reached by the team; duplicate accounts collapse to one entry. A nation winner
leaves the game unrated. `CHECKPOINT_VERSION` and `ranked-ratings.json` version
1 are unchanged; existing files load and keep their points.

### Points are hidden

- `LeaderboardPlayerList` now renders only **Rank / Player / Games**; the ELO
  column, row cells and pinned-user cell are gone.
- `LobbyPlayerView` no longer renders `ClientInfo.elo` beside names, and
  `NameVisibility.lobbyClients` no longer puts `elo` in the lobby wire payload.
- `Matchmaking` and `RankedModal` no longer show "Your ELO"; `RankedModal` is a
  plain 1v1/2v2 picker.
- Local `/api/users/@me` no longer returns a ranked `leaderboard.elo`.
- The public `GET /api/leaderboard/ranked` response still contains
  `elo`/`peakElo` for the separate Norra Real Topplista page. Remove those
  fields from `RankedRatingsStore.leaderboard()` + `ApiSchemas.ts` if the
  external site must hide them too.
- Equal scores sort by `publicId` ascending; the client shows the first five
  rows of page 1.

## 3. Other ranked behavior still in place

- **Balanced team lobbies** (previous session, `ranking/TeamBalancing.ts`):
  ranked Team-mode lobbies pin `teamIndex` so team point sums are as close as
  possible; equal-point lobbies fall back to the normal assignment. It uses the
  hidden points internally only.
- **Resume gating**: a started save keeps its ranked flag only if every human
  alive in the last checkpoint reclaims their seat with the original account
  before the host's resume countdown starts play; otherwise the game archives
  unrated. `SavedLobbySchema.aliveClientIDs` stores the checkpoint's alive set.
- **Discord** ranked-start notification (`RankedLobbyNotifier.ts`) unchanged.

## 4. Verification

- `npx tsc --noEmit`, ESLint, Oxlint, Prettier clean.
- `npx vitest run tests/server tests/client/ApiPlayerLeaderboard.test.ts
tests/client/LeaderboardModal.test.ts tests/client/LobbyPlayerViewPoints.test.ts
tests/TranslationSystem.test.ts tests/EnJsonSorted.test.ts tests/ApiSchemas.test.ts`:
  **919 passed, 4 failed**. The four failures are the documented pre-existing
  ones: `GameServerWire` golden transcript, `HostedLobbyListing`,
  `GameServerPhase`, and `TranslationSystem`'s 4 unused keys
  (`error_modal.turnstile_error`, `events_display.attack_cancelled_retreat`,
  `main.clans`, `main.inventory`). No new failures.
- Not browser-tested: server/client text-only changes; no simulation or wire
  format changed.

## 5. Open items

- **Tuning**: `RANKED_WINNER_ELO = 100` is a first guess. The ladder is
  positive-sum, so points measure attendance × placement; a long streak can
  still lead for weeks. No decay or eligibility window is implemented.
- **Public API leak**: `elo`/`peakElo` are still returned by
  `/api/leaderboard/ranked` (see above).
- **Leaderboard ties**: ties at the five-row cutoff are chosen by opaque
  `publicId`; change the comparator in `RankedRatingsStore.leaderboard()` if a
  fairer rule (games/recency) is wanted.
- **Resume gating limits**: the alive set comes from the latest accepted host
  checkpoint and may be older than the save (stricter, never more permissive);
  saves without a checkpoint require every non-spectator seat. There is no UI
  message when a resume loses its ranked status — only the server log
  `resumed ranked game is unranked: players did not rejoin`.
- **Deployment**: the Fly app `openfrontio` builds from
  `NorrasOFF/NorraRealFront` `main`, not from this fork. The 2026-11-09 PR #35
  merge (`b949a4e04`) produced no Fly deployment; it was shipped manually with
  `flyctl deploy --remote-only --ha=false --build-arg GIT_COMMIT=b949a4e04…`
  (release v188). If pushes to `main` stop deploying, check the Fly dashboard
  "Auto-Deploy on push" checkbox and the Fly GitHub App's Recent Deliveries.
  `hexfront-dev` has no push access to `NorrasOFF/NorraRealFront`; a probe push
  must be made by the owner. `flyctl` is at `C:\Users\ai51940\.fly\bin\flyctl.exe`;
  set `FLY_API_TOKEN` from `H:\Documents\fly-token.txt`.
