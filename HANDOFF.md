# Handoff — save-import hardening; saves moved to the /data volume

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
- This session's commit: **`9c2b5f1e3`** (save-import hardening + volume config).
- Fly app `openfrontio`, one machine, image built from `NorrasOFF/NorraRealFront`
  `main` — **not** from this fork. Deploying this work still requires landing it
  in that repo (or building the fork and pushing the image).

## 2. Security review of save import/export ("can a save upload malware?")

No RCE / webshell path: nothing from a save file is executed, imported, or
written verbatim. Import parses Zod-validated objects and re-encodes them; every
store path is built from `GAME_ID_REGEX = ^[A-Za-z0-9]{8}$`; export is a
creator-only `application/gzip` attachment. The real liabilities were DoS and
ladder fraud. Four fixes in `9c2b5f1e3`:

- **Gzip bomb (high).** `decodeCheckpointWire` inflated `gz:` payloads with no
  output bound. Measured: a **1.39 MB** string → **1 GiB** output and ~**2.1 GB
  RSS**; the Fly worker has **512 MB**. Reachable from a signed-in
  `POST /api/saves/import` and re-triggered by resume/export.
  Now the wire form is capped at `MAX_CHECKPOINT_COMPRESSED_TRANSFER_BYTES`
  (16 MiB) and decompression at `MAX_CHECKPOINT_DECOMPRESSED_BYTES` (128 MiB);
  oversized/unreadable checkpoints are dropped and the save resumes from full
  history.
- **Imported saves could claim ranked/Public (medium).** `gameConfig` came from
  the client-authored file. Import now forces `gameType: Private` and strips
  `ranked`, `rankedType`, `allowedPublicIds`, `nameRevealPublicIds`,
  `nameReveals`, `liveStatsEnabled`. Server-stored saves, autosave and normal
  resume still keep ranked status (a ranked resume still requires every alive
  seat to rejoin).
- **Re-import disk amplification (med-high).** `save(lobby, 0)` appended the
  whole turn log to the append-only history on every import; retention never
  deletes the newest save, so one game could grow without bound. Import now
  deletes the caller's existing save first (after the new file parses) and
  replaces it.
- **Import concurrency (medium).** One import in flight per worker
  (`429 import_busy`); bodies are buffered up to 64 MB and previously several
  could parse in parallel.

Residual, deliberately not changed: `MAX_SAVE_IMPORT_UNCOMPRESSED_BYTES` is
still 256 MiB (one huge file can spike memory; the single-import gate limits the
blast radius), no per-account import quota (only per-IP 20 req/s), and hosted
ranked checkpoints are still trusted for their alive set (the sim is
client-side anyway).

## 3. Saves on the volume (implemented, not deployed)

- `fly.toml` now sets `SAVE_DIR = "/data/saves"` and
  `SAVE_DIR_BUDGET_BYTES = "805306368"` (768 MiB of the 1 GB `/data` volume,
  leaving ~256 MiB for `/data/auth` + filesystem slack).
- `ServerEnv.saveDirBudgetBytes()` parses the new env var (invalid/empty →
  built-in default) and `Worker.ts` passes it to `FilesystemSaveStore`. Without
  it the default 2 GiB budget is larger than the whole volume, so `prune()`
  would never run before the disk filled.
- Retention (hourly + at startup): drop saves not saved in 30 days, keep the
  newest 20 per creator, then evict oldest until under the byte budget — always
  keeping at least one save.
- Existing saves live on the container rootfs and are **not migrated**. Any
  save worth keeping must be exported and re-imported after the switch; the
  import path then writes it to the volume.

### Measured save sizes (entity-heavy, `perf:entities`)

| Scenario                                               | Units | plain checkpoint | wire checkpoint |
| ------------------------------------------------------ | ----: | ---------------: | --------------: |
| big_plains, 160 buildings / 320 posts / 413 trains     | ~1.9k |          1.06 MB |         0.09 MB |
| world, 2000 buildings / 600 posts / 1470 trains        | 4,075 |          15.8 MB |     **1.63 MB** |
| giantworldmap, 1200 buildings / 300 posts / 539 trains | 1,739 |          42.1 MB |     **2.59 MB** |

Turn history is tiny (54 KB gz for 11,182 turns). The real 3.81 MB Five Islands
save is an older plain-format checkpoint. Budget for **~2–3 MB per heavy save**
(≈250–350 heavy saves at 768 MiB; ~200 with 25% slack). The `gz:` checkpoint
wire form makes entity count a small share of the stored size; map size dominates.

## 4. Verification

- `npx tsc --noEmit`, Oxlint, ESLint, Prettier clean.
- `CheckpointCodec`, `SaveImport`, `ServerEnv`, `server/SaveStore`: 79 pass.
- New tests: gzip bomb rejected under a byte cap, oversized wire rejected,
  oversize imported checkpoint dropped, imported config forced private/unranked,
  `SAVE_DIR_BUDGET_BYTES` parsing.
- Pre-existing failures unchanged: `tests/ListSavedLobbies.test.ts` "reports a
  network failure per worker" times out on clean HEAD too (verified by stash);
  the documented `SAMLauncherExecution`, `GameServerWire`, `HostedLobbyListing`,
  `GameServerPhase` and localStorage failures are unrelated.

## 5. Open items

- **Deploy.** Land `9c2b5f1e3` in `NorrasOFF/NorraRealFront` `main` (the build
  source) so the worker restart fix from `e7b7d541c` and this hardening go live.
  The `fly.toml` env entries only take effect when that deploy happens; confirm
  with the startup log `resumable save store: /data/saves/w0 (byte budget …)`.
- After deploy: create one save, `ls /data/saves/w0` (expect `*.head.json`,
  `*.history.gz`, `*.meta.json`, optional `*.checkpoint.json.gz`), restart the
  machine, resume it.
- If heavy-save volume grows past ~250, extend the volume (Fly volumes only
  grow) and raise `SAVE_DIR_BUDGET_BYTES`; do not put the budget back at the
  2 GiB default while sharing `/data` with auth.
- Optional follow-up: per-account import rate limit (not just per-IP), and
  archive-verified ranked import if imported ranked saves are ever wanted.
