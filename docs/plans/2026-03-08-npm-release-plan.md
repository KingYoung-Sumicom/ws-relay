# npm Release Preparation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up GitHub Actions CI and publish workflows for @sumicom/ws-relay with OIDC trusted publishing.

**Architecture:** Two workflows — `ci.yml` runs tests/typecheck/build on every push and PR; `publish.yml` publishes to npm with OIDC provenance when a `v*` tag is pushed. No npm token secrets needed after initial trusted publisher config.

**Tech Stack:** GitHub Actions, Node 20, npm with OIDC trusted publishing, vitest

---

### Task 1: Create CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create the CI workflow file**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test:coverage
      - run: npm run build
```

**Step 2: Verify the workflow YAML is valid**

Run: `npx yaml-lint .github/workflows/ci.yml || echo "install yamllint if needed"`
Or just visually confirm the YAML is well-formed.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add CI workflow for test, typecheck, and build"
```

---

### Task 2: Create Publish Workflow

**Files:**
- Create: `.github/workflows/publish.yml`

**Step 1: Create the publish workflow file**

```yaml
name: Publish

on:
  push:
    tags:
      - 'v*'

permissions:
  id-token: write
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          registry-url: https://registry.npmjs.org
      - run: npm install -g npm@latest
      - run: npm ci
      - run: npm test
      - run: npm run build
      - run: npm publish --provenance --access public
```

Key details:
- `permissions.id-token: write` enables OIDC token generation
- `registry-url` in setup-node is required for npm publish auth
- `npm install -g npm@latest` ensures npm >= 11.5.1 for trusted publishing
- `--provenance` adds supply chain attestation
- No `NODE_AUTH_TOKEN` or `NPM_TOKEN` needed — OIDC handles auth

**Step 2: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: add npm publish workflow with OIDC trusted publishing"
```

---

### Task 3: Verify Build and Tests

**Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 2: Run build**

Run: `npm run build`
Expected: `dist/` directory created with compiled JS + declarations.

**Step 3: Verify package contents with dry run**

Run: `npm publish --dry-run`
Expected: Output shows only `dist/`, `package.json`, `README.md`, `LICENSE`. No source files, no test files, no config files.

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

---

### Task 4: Test CI Locally with act

Per project CLAUDE.md, run `act` to validate the CI workflow locally before pushing.

**Step 1: Run act**

Run: `act -j test` (runs the test job from ci.yml)
Expected: Job completes successfully.

Note: If act isn't configured for this repo or has issues, this step is advisory — the real validation happens when we push and GitHub runs the workflow.

---

### Task 5: Commit and Push

**Step 1: Commit all remaining changes (if any)**

```bash
git add .
git commit -m "ci: add GitHub Actions CI and publish workflows"
```

**Step 2: Push to remote**

```bash
git push origin main
```

**Step 3: Verify CI runs on GitHub**

Check: `gh run list --limit 1`
Expected: CI workflow triggered and passes.

---

## Post-Implementation: First Publish Checklist (Manual)

After the CI workflow is verified, complete these steps manually:

1. `npm login` — authenticate with npmjs.com
2. Create `@sumicom` org on npmjs.com if it doesn't exist
3. `npm publish --access public` — publish v0.1.0
4. Go to `https://www.npmjs.com/package/@sumicom/ws-relay/access`
5. Configure Trusted Publisher → GitHub Actions:
   - Organization: `KingYoung-Sumicom`
   - Repository: `ws-relay`
   - Workflow: `publish.yml`
6. Future releases: `npm version patch && git push --tags`
