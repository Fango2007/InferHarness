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
- Preserve the Keep a Changelog structure when updating `CHANGELOG.md`:
  - Add entries under the correct category heading, such as `Added`, `Changed`, `Fixed`, `Removed`, or `Security`.
  - Create a missing category heading when needed.
  - Do not flatten, rename, or reorder existing release/category headings unless the task explicitly requires it.
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

## Common Commands

- Standard validation from the repo root: `npm run lint`, `npm test`, `npm run build`, and `npm run release:check`.
- Workspace test shortcuts: `npm -w backend run test` and `npm -w frontend run test`.
- Local development: `npm run dev` starts backend and frontend together; use `npm run start:backend` and `npm -w frontend run dev` when you need separate terminals or custom ports.
- End-to-end tests: start the app with `npm run e2e:serve`, then run `npm -w frontend run e2e`.

## Release Workflow

- For release preparation, read `RELEASING.md` before changing versions, changelog entries, release commits, or tags.
- Use `npm version <version> --workspaces --include-workspace-root --no-git-tag-version` to keep workspace package versions aligned without creating an automatic tag.
- Use annotated release tags (`git tag -a`) so `--follow-tags` and the release workflow pick them up.
- Create and push the release tag only after the release commit is merged into `origin/main`; run `git fetch origin` and `git merge-base --is-ancestor <release-commit> origin/main` first.
- Before calling a release complete, use `git ls-remote --tags origin "refs/tags/vX.Y.Z^{}"` to verify the remote tag resolves to the merged release commit, then confirm the GitHub release contains its notes and source archives.
- If `npm run release:check` fails with `ELOOP` under `specs/specs/...`, inspect the worktree for a local recursive `specs` symlink before changing tracked files.

## Static Data and Reference Content

- Do not hardcode static data in application code.
- Store static prompts, templates, schemas, fixtures, examples, and other long-lived reference content in dedicated files or data resources.
- Keep code responsible for orchestration, validation, and transformation rather than embedding large static payloads directly.
- Use the benchmark document APIs or UI for user-created templates, datasets, runtime profiles, and plans so changes persist under `INFERHARNESS_BENCHMARK_LIBRARY_ROOT` and can be re-imported after database rebuilds.
- Use the Datasets page or JSONL dataset-file API for benchmark item files under `INFERHARNESS_BENCHMARK_DATASET_ROOT`; saved files should stay paired with synced `dataset_manifest` documents.

## Node.js Runtime

InferHarness is pinned to Node 25.x. Before running `npm install`, `npm rebuild`, backend startup, tests, or any command that can compile native modules, verify:

```sh
node -v
npm run check:node
```

Do not run dependency install or rebuild commands from a shell using Node 26+ or Node <25. Native modules such as `better-sqlite3` can be compiled against the wrong Node ABI and break backend startup in other worktrees.
