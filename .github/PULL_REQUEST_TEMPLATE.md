## What and why

## Verification
- [ ] `pnpm run typecheck && pnpm test && pnpm run check:schema`
- [ ] New scenario or check: invariant stated, expectation derived from the requirement (not from output), test added
- [ ] Four levels still reported separately; evidence class labelled correctly
- [ ] If a dependency pin changed: sources re-read, both suites re-run, `docs/evidence/` re-recorded
- [ ] No secret in any file, report or log
