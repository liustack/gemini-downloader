---
summary: 'PR workflow: commit, push, and create Pull Request end-to-end'
read_when:
  - Creating a Pull Request
  - Pushing code to remote
  - Need the full commit-push-pr flow
---

# PR Workflow

## Full Flow

1. **Commit**: follow the conventions in `docs/commit.md`
2. **Check branch**:
   ```bash
   git branch --show-current
   ```
   If on main, create a feature branch first:
   ```bash
   git checkout -b <descriptive-branch-name>
   ```
3. **Push**:
   ```bash
   git push -u origin $(git branch --show-current)
   ```
4. **Create PR**:
   ```bash
   gh pr create --title "<concise title>" --body "$(cat <<'EOF'
   ## Summary
   <1-3 bullet points>

   ## Test plan
   - [ ] <test checklist item>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```
5. Output the PR URL

## PR Title Guidelines

- Keep under 70 characters
- Use the description/body for details, not the title
