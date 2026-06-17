# Project Workflow Rules

## Working Style

- Do not assume the user's first request is the best solution. Challenge ideas, ask questions, and surface confusion instead of hiding it.
- Prioritize simplicity. Criticize when useful, explain tradeoffs, and suggest a smaller path when the requested approach looks too complex.
- Use an available skill when it fits the task. If similar prompts are likely to recur, suggest creating a dedicated skill.
- For technology choices, project structure, shell commands, and other local context, read the current plan before making changes.

## Branch and Change Hygiene

- Start every new change on a new git branch before editing files.
- If a focused branch is not already checked out, create one before implementation unless the user explicitly says not to.
- Update `CHANGELOG.md` in the same change whenever code, tests, docs, configuration, or user-facing behavior is modified.
- Check whether the root `README.md` still matches the purpose and user-visible behavior of the change. Update it in the same change if it would otherwise become stale or misleading.
- At the end of each completed change, explicitly ask whether to commit. Include:
  - a concise suggested commit message
  - short commit details covering the files and behavior changed

## Parallel Worktrees

- This repo may use multiple git worktrees in parallel for separate features or agents.
- Treat each worktree as isolated. Do not assume changes from another worktree are available locally.
- Treat `origin/main` as the source of truth for the current base branch. Local `main` may be stale.
- Before asking whether to commit and push, fetch `origin` and check the current branch against both local `main` and `origin/main`.
- Commit local work whenever it is coherent. If the branch is behind or diverged from `origin/main`, commit first when needed, then update the branch against the current base before final validation or push.
- Do not describe a branch as ready for review, PR, or merge until it is checked against `origin/main` and any conflicts or drift are resolved.
- After a branch is merged, resync any related worktrees from the updated base branch before continuing dependent work.
- Re-check the Node.js runtime before installs, rebuilds, backend startup, or tests in each worktree.

## Static Data and Reference Content

- Do not hardcode static data in application code.
- Store static prompts, templates, schemas, fixtures, examples, and other long-lived reference content in dedicated files or data resources.
- Keep code responsible for orchestration, validation, and transformation rather than embedding large static payloads directly.

## Node.js Runtime

InferHarness is pinned to Node 25.x. Before running `npm install`, `npm rebuild`, backend startup, tests, or any command that can compile native modules, verify:

```sh
node -v
npm run check:node
```

Do not run dependency install or rebuild commands from a shell using Node 26+ or Node <25. Native modules such as `better-sqlite3` can be compiled against the wrong Node ABI and break backend startup in other worktrees.
