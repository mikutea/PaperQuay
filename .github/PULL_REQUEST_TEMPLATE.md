## Scope and verification

- [ ] The branch contains only the intended fixes; unrelated user work is preserved.
- [ ] TypeScript, the complete `.ts` + `.mjs` test suite, and the production build pass.
- [ ] Changed Electron/Reader interactions were checked in an isolated profile (or limits are stated below).

## Review gate — complete after the final push

- [ ] `chatgpt-codex-connector` code review completed for this exact head SHA.
- [ ] `chatgpt-codex-connector` security review completed for this exact head SHA.
- [ ] Every inline finding was checked against current code, fixed with evidence or answered with a reason; no actionable P1/P2 remains.
- [ ] Required CI is green for this exact head SHA.

Do not merge or tag a release while any review is pending. Recheck every box after a new push.
