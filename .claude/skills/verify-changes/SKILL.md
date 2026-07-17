---
name: verify-changes
description: Run this project's typecheck, tests and lint without corrupting the repo. Use before reporting any backend or frontend change as done, and whenever you are about to run lint, format, or prettier here.
---

# Verifying changes

## Never run these

```
npm run lint      # backend: eslint ... --fix   <- REWRITES FILES
npm run format    # backend: prettier --write   <- REWRITES FILES
npx prettier --write ...
npx eslint --fix ...
```

The backend's `lint` script has `--fix` baked in. One run rewrites ~44 files across the
repo — roughly +1200/-300 lines of pure reflow — and buries the real diff. It exits
cleanly and says nothing.

The reason it's so destructive: the backend lints at **323 errors, of which 307 are
prettier-fixable**. That is not rot. The source is hand-written at ~100 columns and
prettier's config says 80, so `--fix` "fixes" 307 real lines by reflowing essentially
the whole codebase. Those 307 are a landmine, not a to-do list. Don't reformat the repo
to clear them.

The **frontend's** `lint` has no `--fix` and is safe to run.

## Run these instead

```bash
# backend
cd backend
npx tsc --noEmit -p tsconfig.json     # must be silent
npx jest                              # 217 tests, ~11s, offline
npx eslint src/path/you/touched       # NO --fix, scoped to your files

# frontend
cd frontend
npm run typecheck
npm run lint                          # safe here — no --fix
```

## Lint is a delta, not a number

A lint count is not "errors I introduced" — most are pre-existing. Measure the baseline:

```bash
git stash -q -u
npx eslint <the same paths>           # <- baseline
git stash pop -q
npx eslint <the same paths>           # <- current; the difference is yours
```

Known baselines (verified 2026-07-17), for the **no-`--fix`** invocation:

| Scope                             | Baseline |
| --------------------------------- | -------- |
| backend `{src,test}/**/*.ts`      | 323      |
| `src/config/env.validation.ts`    | 1        |
| `test/canary/amazon-currency.*`   | 5        |
| frontend `.`                      | 1        |

Fix only errors that are yours, by hand, matching the surrounding ~100-column style.

## Then check the blast radius

```bash
git status --short
git diff --stat
git diff -U0 <your file> | grep '^-' | grep -v '^---'   # removals = collateral reflow
```

Files you never edited appearing here means something reformatted them. Revert
everything that isn't yours before going further:

```bash
git status --short | grep '^ M' | awk '{print $2}' \
  | grep -vE '^(path/you/meant|other/path)$' | xargs git checkout --
```

## Test tiers

| Tier    | Command                | Network | Use                                 |
| ------- | ---------------------- | ------- | ----------------------------------- |
| unit    | `npx jest`             | none    | always                              |
| fixture | `npx jest`             | blocked | real Chrome, frozen HTML            |
| e2e     | `npm run test:e2e`     | local   | needs both servers up; auto-skips   |
| canary  | `npm run test:canary`  | LIVE    | deliberate only — **never in CI**   |

**The frontend has no test runner** — no vitest, no jest, by design. A frontend change is
verified by typecheck + lint + driving the UI. "Tests pass" is never evidence about
frontend behaviour; there are none.

## Before saying "done"

- Typecheck silent, `npx jest` green, lint delta zero.
- `git diff --stat` shows only files you meant to touch.
- Anything you couldn't verify (live site walled, no test tier for it) gets said plainly
  rather than implied as checked.
