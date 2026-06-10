# Releasing

This repository ships source releases for local desktop deployment.
It does not currently publish standalone installers or a compiled backend bundle.

## Release checklist

1. Update `CHANGELOG.md`.
2. Run `npm ci`.
3. Run `pip install -r backend/src/scripts/requirements.txt`.
4. Run `npm run release:check`.
5. Commit the release changes.
6. Create and push the tag (replace `X.Y.Z` with the version from `package.json`).
   Use an **annotated** tag (`-a`): `--follow-tags` only pushes annotated tags, so a
   lightweight `git tag vX.Y.Z` would be silently skipped and the release workflow would
   not trigger.

```bash
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin main --follow-tags
```

7. Open the GitHub release created by Actions and verify:
   - release notes are present
   - attached source archives are present
   - README desktop deployment steps are accurate

## Desktop deployment from the release

Users should:

1. Download the release source archive from GitHub.
2. Install Node.js `>=22.19 <26` and Python 3.10+; Node 25 matches CI.
3. Copy `.env.example` to `.env` and set the token.
4. Run:

```bash
npm ci
pip install -r backend/src/scripts/requirements.txt
npm run build
npm start
```

The backend listens on `http://localhost:8080` and the frontend on `http://localhost:5173` by default.
