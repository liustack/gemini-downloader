---
summary: 'Testing guide: Vitest commands, path constraints, coverage'
read_when:
  - Running tests
  - Writing tests
  - Debugging test failures
---

# Testing Guide

## Key Constraint

**Always run from the repository root** to avoid `globalSetup` and alias path mismatches.

## Commands

```bash
# Run all tests
pnpm test

# Run a single test file
pnpm exec vitest run <test-file-path>
```

## Before Running Tests

- Ensure type checking passes for the relevant code
- Changes should include verifiable tests

## Directories

| Path | Purpose |
|------|---------|
| `test/` | Main test directory |
| `coverage/` | Coverage output |
