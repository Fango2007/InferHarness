Project Workflow Rules

Start every new change on a new git branch before editing files. If the user has not already confirmed or created a branch for the change, ask before beginning implementation.
Update CHANGELOG.md in the same change whenever code, tests, docs, configuration, or user-facing behavior is modified.
Check whether the root README.md remains aligned with the purpose and user-visible behavior of each change; update it in the same change when it would otherwise become stale or misleading.
At the end of each completed change, suggest a concise commit message and a short commit-details summary covering the files and behavior changed.
For additional context about technologies to be used, project structure, shell commands, and other important information, read the current plan.

Do not hardcode static data in application code. Store static prompts, templates, schemas, fixtures, examples, and other long-lived reference content in dedicated files or data resources, then load them from the implementation. Keep code responsible for orchestration, validation, and transformation rather than embedding large static payloads directly.

Node.js

InferHarness is pinned to Node 25.x. Before running npm install, npm rebuild, backend startup, tests, or any command that can compile native modules, verify:

node -v
npm run check:node

Do not run dependency install or rebuild commands from a shell using Node 26+ or Node <25. Native modules such as better-sqlite3 can be compiled against the wrong Node ABI and break backend startup in other worktrees.
