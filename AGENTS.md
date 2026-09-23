# PaperQuay fork working agreement

This fork's `main` is the integrated release branch. Keep unrelated user data,
the live PaperQuay profile, and running app processes untouched. Use an isolated
profile for Electron acceptance; never force-close a user's active PaperQuay.

Keep fork-specific fixes small and close to upstream behavior. Do not broadly
refactor upstream code or add compatibility layers solely to preserve locally
generated fork data; prefer a scoped, backed-up local regeneration when needed.

## Code Review Rules

- Open a PR for changes to `main`. A passing CI run is not approval.
- After each PR creation **and each push**, wait for the
  `chatgpt-codex-connector` code and security reviews to finish for the exact
  current head SHA. Do not merge while either review is pending.
- Read every review submission and inline thread, including comments on a PR
  that was closed or merged. Validate each finding against the current code;
  fix actionable findings with regression tests, or explain with evidence why
  one is not applicable. Reply to the thread and resolve it only after the
  evidence is present in the PR. Re-run the gate after a follow-up push.
- Merge only when required CI is green and no actionable P1/P2 review finding
  remains. Then verify the resulting `main` commit and release ancestry before
  tagging. Never use a GitHub release or a green build as a substitute for
  this review gate.

## Verification

- Run `node --test "tests/*.test.ts" "tests/*.test.mjs"`, TypeScript, and a Vite production build. On Windows, run frontend build from the mapped `Y:` path; Vite cannot resolve its own package from the UNC form of this workspace.
- For rendered Reader changes, verify the relevant interaction in an isolated
  Electron profile, not just a browser-only Vite page without the Electron
  bridge. State any interaction that could not be exercised.
- For a fork release, verify packaged runtime dependencies, the published
  prerelease assets and checksums, and `Update-PaperQuayFork.ps1 -CheckOnly`.
  Stage or install only after the review gate; do not replace a running app.
