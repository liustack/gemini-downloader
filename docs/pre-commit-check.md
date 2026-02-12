---
summary: 'Pre-commit checks: run lint, format, and tests in one pass'
read_when:
  - About to commit (final check)
  - Reproducing CI failures locally
---

# Pre-Commit Checks

Run the following in order. Fix errors immediately before proceeding:

```bash
# 1. Lint
pnpm lint

# 2. Format
pnpm format-code

# 3. Test
pnpm test

# 4. Verify status
git status --short
```

Only commit after all checks pass.
