# npm Release Design: @sumicom/ws-relay

## Goal

Set up automated npm publishing via GitHub Actions with Trusted Publishing (OIDC) — no stored npm tokens.

## First Publish (Manual)

The npm Trusted Publisher UI requires the package to exist before configuration.

1. `npm login` → authenticate locally
2. Create `@sumicom` npm org if it doesn't exist
3. `npm run build && npm publish --dry-run` → verify package contents
4. `npm publish --access public` → publish v0.1.0

## Trusted Publisher Configuration

After the first publish, configure on npmjs.com:

1. Navigate to `https://www.npmjs.com/package/@sumicom/ws-relay/access`
2. Under Trusted Publisher → GitHub Actions:
   - Organization: `KingYoung-Sumicom`
   - Repository: `ws-relay`
   - Workflow: `publish.yml`
3. Save

## CI Workflow: `.github/workflows/publish.yml`

Triggers on push of `v*` tags. Uses OIDC (no `NPM_TOKEN` secret).

```yaml
permissions:
  id-token: write
  contents: read
```

Steps:
1. Checkout
2. Setup Node 20
3. Upgrade npm to latest (trusted publishing requires >= 11.5.1)
4. `npm ci`
5. `npm test`
6. `npm publish --provenance --access public`

## CI Workflow: `.github/workflows/ci.yml`

Runs on all pushes and PRs. Gates: lint/typecheck, test, build.

## Future Release Flow

```
npm version patch|minor|major  # bumps version, creates git tag
git push && git push --tags    # CI publishes via OIDC
```

## package.json Status

Already configured correctly:
- `name`: `@sumicom/ws-relay`
- `version`: `0.1.0`
- `exports`: ESM with types for `.` and `./client`
- `files`: `["dist"]`
- `prepublishOnly`: `npm run test && npm run build`
- `publishConfig.access`: `public`
- `repository.url`: matches GitHub repo

No changes needed to package.json.
