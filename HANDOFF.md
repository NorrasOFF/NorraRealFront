# Handoff — Reverted PR #14 (train/railroad); blocked landing on NorrasOFF

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Tokens (both authenticate as **`hexfront-dev`**):
  - `H:\Documents\Hexfront-token.txt` — write access to the fork only.
  - `H:\Documents\Norrasoff-token.txt` — **read-only**; see the blocker below.
- Remotes: `origin` = `hexfront-dev/NorraRealFront-Remus-` (branch `main`),
  `norrasoff` = `NorrasOFF/NorraRealFront`, `upstream` = `openfrontio/OpenFrontIO`,
  `hexfront` = `hexfront-dev/OpenFrontIO`.
- Local branches: `main` still at `647ca65a4`; work is on `revert-pr-14`.

## 2. What changed this session

Reverted the latest PR on `NorrasOFF/NorraRealFront`: **PR #14 "Nya täggrejer"**
(merge commit `1d963cf20`, 6 commits from the fork: informational `Railroad`
unit, defense-post drag upgrades, run-openfront e2e skill docs, railroad
checkpoint test, handoff notes).

- `git revert -m 1 1d963cf20` produced commit **`9b31b8789`**. Its tree is
  **exactly equal** to the pre-merge base `96ce9a417` (`git diff 96ce9a417 HEAD`
  is empty), i.e. a clean, conflict-free revert of the merge.
- Pushed to the fork: `origin/main` is now `9b31b8789` (fast-forward from
  `647ca65a4`).

## 3. BLOCKER — cannot write to NorrasOFF/NorraRealFront

The provided Norrasoff token cannot write to `NorrasOFF/NorraRealFront`. Verified
(HTTP 403) for: git `push`, `POST /git/refs` (create branch), and
`POST /pulls` (open PR). The Hexfront token writes the fork but is also 403 on
NorrasOFF. The repo API reports `permissions.push = true` for the user, so it is
the **token scope**, not repo membership: a fine-grained PAT with no
`Contents: write` on that repo.

To land the revert, either grant `hexfront-dev` a token with **Contents: write**
(and **Pull requests: write** to open a PR) on `NorrasOFF/NorraRealFront`, or
push/merge from a machine that has it.

## 4. How to land it once write access exists

The fork `main` (`9b31b8789`) already contains `1d963cf20` as an ancestor, so a
PR from `hexfront-dev:main` → `NorrasOFF:main` diffs to exactly the revert commit
and can merge via fast-forward. Direct push is equivalent:

```powershell
$tok = (Get-Content -Raw "<write-capable-token>").Trim()
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
git -C "C:\Users\ai51940\OpenFrontIO" -c http.extraheader="Authorization: Basic $b64" `
  push norrasoff revert-pr-14:main
```

## 5. Open items / next steps

- Land `9b31b8789` on `NorrasOFF/NorraRealFront` main (blocked, see §3).
- After it lands, `norrasoff/main` should equal the `96ce9a417` tree (PR #13 and
  earlier are untouched; the revert only undoes PR #14).
- The pre-existing suite failures listed in `testnotes.md` still stand.
