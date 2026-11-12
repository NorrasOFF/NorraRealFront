# Handoff — server-side checkpoint validation no longer decodes the map

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`, branch `defense-post-priority`.
- Token `H:\Documents\Hexfront-token.txt` authenticates as **`hexfront-dev`**.
- Ship target: `origin` = `hexfront-dev/NorraRealFront-Remus-`, branch `main`
  (`git push origin HEAD:main`; use a credential-in-URL remote because the
  credential-manager prompts fail in this shell).
- This session's commit: the tip of `main` after this push ("Validate
  checkpoints from metadata instead of decoding the map").
- Fly app `openfrontio`, one machine, image built from `NorrasOFF/NorraRealFront`
  `main` — **the deploy still has to happen from that repo**. The live machine
  was on `deployment-336dbfeaf42947659623bbfb0f474a1b` while this was written.

## 2. Outage: site frozen, logins failing (`account_modal.local_failed`)

Symptom on 2026-11-12: the loading screen hung; `/api/auth/login` produced
`account_modal.local_failed`, which is the generic client bucket (network error,
non-JSON body, or an unrecognised non-2xx).

What it actually was:

- `GET https://openfrontio.fly.dev/api/health` returned a **container-nginx 504
  after ~87 s**, not a Fly proxy error and not a fast 502 — so nginx was alive
  while the Node master on `127.0.0.1:3000` did not answer.
- The machine was **stopped**; the request-triggered auto-start did not recover
  it, and the machine was stopped again (`exit_code=-1, oom_killed=false,
requested_stop=true`). `flyctl machine start` booted it in ~9 s and health
  went to 200; a live login then returned the correct `401
invalid_credentials`.
- Last app log before the freeze: `reassembled chunked checkpoint, decoding`
  for a **5.53 MB** chunked upload. No `accepted host checkpoint` line followed.

The game worker is **472 MB RAM, 1 shared vCPU, no swap**. Checkpoint
validation used `decodeCheckpointWire`, which inflates the whole gzip payload,
copies every map array and JSON-parses the entire player/unit graph — only to
read `ticks` and the alive seats. A large late-game checkpoint can spike
hundreds of MB on the shared box, which wedges the master too (so every HTTP
request hangs, hence the 504s and the failed login).

## 3. Fix: metadata-only server decode

`decodeCheckpointWireMetadata()` in `src/core/CheckpointCodec.ts`:

- Streams the gzip, keeps only the Phase 8 JSON body (capped at
  `MAX_CHECKPOINT_METADATA_BYTES`, 32 MiB) and **discards the map arrays**.
- Still reads the stream to the end, so the **gzip CRC is verified**.
- Still validates `GZCP` magic/version, flags/length parity, presence bits and
  `header + body + declared map lengths <= decompressed size` (the same checks as
  `decodeBinaryCheckpoint`), then `isGameCheckpoint` on the body.
- Legacy `gz:`-as-tagged-JSON payloads are retained in full under the same cap.

Server call sites switched from `decodeCheckpointWire` to the metadata variant:
`GameServer.acceptCheckpointWire` (also `aliveClientIdsFromCheckpoint` now takes
`Pick<GameCheckpoint, "players" | "stats">`), both `SaveImport` directions, and
the `Worker.ts` resume validation. The stored wire string, `CHECKPOINT_VERSION`
(5), schemas, export/import format and the client's full decode are **unchanged**.

Only behavior change: a checkpoint whose JSON body exceeds 32 MiB is dropped and
the save resumes from full turn history instead (no data loss; real bodies are
~1–2 MiB). This is the intended bomb/abuse ceiling, not a format change.

## 4. Fly config

`fly.toml` now has an `[[http_service.checks]]` on `/api/health`
(20 s grace, 15 s interval, 5 s timeout) so a wedged-but-running machine is
detected instead of serving 60 s 504s indefinitely.

`min_machines_running` is deliberately **0**. It was briefly raised to 1 during
diagnosis to remove the cold-start window, and the owner explicitly rejected
paying for an always-on machine. Do not set it back to 1 without asking. If a
faster scale-to-zero resume is wanted later, the option is
`auto_stop_machines = 'suspend'` (still not always-on); health checks do nothing
while the machine is stopped, and an auto-start failure is a Fly-platform issue,
not something app code can fix.

## 5. Verification

- `npx tsc --noEmit`, Oxlint, ESLint, Prettier clean on touched files.
- `tests/core/CheckpointCodec.test.ts`: 30 pass, including binary + legacy
  metadata, large-map body-only decode, truncated-tail CRC rejection, a header
  claiming more map bytes than the payload, the metadata cap and the gzip bomb.
- `SaveImport` + `GameServerSave` + `RankedResumeEligibility` (+
  `Checkpoint`): 84 pass.
- Live machine manually started and verified: `/api/health` 200, live
  `POST /api/auth/login` 401 JSON.

## 6. Open items

- **Deploy** the merged `NorrasOFF/NorraRealFront` `main` (this fix plus the
  health check) — nothing here is live yet.
- Watch the first large-checkpoint game after deploy (`accepted host
checkpoint` should now follow `reassembling chunked checkpoint` without a
  stall).
- The client still performs a full decode on resume; that is fine on a desktop
  browser but worth revisiting if very large saves ever fail to restore there.
