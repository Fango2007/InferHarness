## Node.js

InferHarness is pinned to Node 25.x. Before running `npm install`, `npm rebuild`,
backend startup, tests, or any command that can compile native modules, verify:

```bash
node -v
npm run check:node
```

Do not run dependency install or rebuild commands from a shell using Node 26+ or
Node <25. Native modules such as `better-sqlite3` can be compiled against the
wrong Node ABI and break backend startup in other worktrees.
