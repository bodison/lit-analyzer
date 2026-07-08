# PLAN — Release VSIX workflow

## Goal

Add a GitHub Actions workflow that, on a pushed version tag, builds the
`vscode-lit-plugin` extension, packages it into a `.vsix`, and publishes it as a
GitHub Release with the `.vsix` attached — so users can download and install it
manually (`code --install-extension lit-plugin-<version>.vsix`).

This mirrors the release workflow used in the Notescape and Capabilities-Manager
repos, but adapted to this monorepo's lerna + wireit layout.

## Repo-specific facts this workflow must respect

- **This is a lerna monorepo.** Packages live under `packages/`:
  `lit-analyzer`, `ts-lit-plugin`, `vscode-lit-plugin`.
- **The publishable extension is `packages/vscode-lit-plugin`.**
  - `name: lit-plugin`, `publisher: runem`, `version: 1.4.3`, `main: bundle.js`.
  - The monorepo **root** `package.json` is a _separate_ version (`1.0.0`) — it
    is not the extension version. See the open question below.
- **Packaging command:** the existing `workflow.yml` packages the extension with
  `npm run package` (root, wireit-driven) and the output vsix lands at:
  `packages/vscode-lit-plugin/out/packaged.vsix`
  (note the fixed name `packaged.vsix`, not `lit-plugin-<version>.vsix`).
- **Default branch is `master`** (existing workflows trigger on `push: master`).
  The release workflow triggers on tags, so the branch is irrelevant to it, but
  keep this in mind for docs/examples.
- **`LICENSE.md` and `README.md` exist** at the repo root; the sub-package has
  its own readme. `vsce` won't fail on missing license/readme.

## ⚠️ Why the Node version matters (the critical constraint)

`npm ci` at the repo root triggers the root `postinstall` → `npm run bootstrap`
→ `lerna clean && lerna bootstrap`. This repo uses **lerna 4**, whose bootstrap
step **crashes on Node ≥ 26** with `require is not defined in ES module scope`
(lerna 4's internals use CommonJS `require` in a context newer Node treats as
ESM). This is documented directly in `.github/workflows/workflow.yml`:

```
# NOTE: `npm ci` triggers `lerna bootstrap` (lerna 4) which crashes on
# Node >= 26 ... CI will need either lerna replaced (npm workspaces / pnpm)
# or a leaf-only install strategy.
```

**Consequences for the release workflow:**

- The workflow **must pin a Node version < 26**, or `npm ci` fails before
  anything is built.
- The repo's _working_ VSCode integration test (`test_vscode.yml`) uses
  **Node 16** — that is the only Node version currently proven to install and
  package this repo end-to-end. Node 16 is EOL, so it is a "make it work today"
  choice, not a good long-term one. Node 18 is _likely_ fine (still < 26) but is
  **not currently exercised by any CI here**, so it is unverified.
- **Recommendation:** pin **Node 16** to match the proven config, and add a TODO
  to migrate off lerna 4 (to npm workspaces or pnpm) so the release workflow can
  move to a supported Node. Once lerna is replaced, bump the Node version and
  drop this note.

**Decision point (fill in before implementing):** Node version = `______`
(16 = proven; 18 = probably-works-unverified; 20 = current LTS, higher risk;
26 = matches root Test workflow but currently broken).

## OPEN QUESTION — version guard / tag scheme

The Notescape/Capabilities workflows include a step that fails the release if the
git tag (`vX.Y.Z`) doesn't match `package.json`'s `version`. In this monorepo
that check is ambiguous because there are two versions:

- `packages/vscode-lit-plugin/package.json` → `1.4.3` (the actual extension)
- root `package.json` → `1.0.0`

**Undecided — pick one before implementing:**

1. **Guard against the sub-package** (`packages/vscode-lit-plugin/package.json`).
   Tag `v1.4.3` = next extension release. Most correct for "release the
   extension", but tags then track the sub-package, not the repo root.
2. **No guard.** Simplest; accepts that monorepo tags may not map to a single
   `package.json`. Relies on the person tagging to get the version right.
3. **Guard against root** (`1.0.0`). Only sensible if you decide to tag by repo
   version rather than extension version.

This choice affects (a) whether a guard step exists, (b) which file it reads, and
(c) how the `.vsix` is renamed for the release asset. **Left open per request.**

## Draft workflow (for reference — do NOT commit until the two decisions above are made)

`.github/workflows/release.yml`:

```yaml
name: Release VSIX

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write # required to create the GitHub Release

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0

      - name: Setup Node
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: 16 # <-- see "Why the Node version matters"; MUST be < 26
          cache: npm

      - name: Install dependencies
        run: npm ci # triggers lerna bootstrap — the reason Node is pinned

      # OPEN: version guard goes here if chosen. If guarding the sub-package:
      #   - run: |
      #       TAG="${GITHUB_REF_NAME#v}"
      #       PKG="$(node -p "require('./packages/vscode-lit-plugin/package.json').version")"
      #       [ "$TAG" = "$PKG" ] || { echo "::error::tag v$TAG != $PKG"; exit 1; }

      - name: Package extension
        run: npm run package # wireit → packages/vscode-lit-plugin/out/packaged.vsix

      - name: Rename vsix
        run: mv packages/vscode-lit-plugin/out/packaged.vsix lit-plugin.vsix

      - name: Create GitHub Release
        uses: softprops/action-gh-release@718ea10b132b3b2eba29c1007bb80653f286566b # v3.0.1
        with:
          files: lit-plugin.vsix
          generate_release_notes: true
```

### Notes on the draft

- **Actions are pinned to commit SHAs** (supply-chain best practice). The tags
  they correspond to are in the trailing comments. These SHAs were resolved from
  the GitHub API on 2026-07-01:
  - `actions/checkout` v7.0.0 = `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`
  - `actions/setup-node` v6.4.0 = `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e`
  - `softprops/action-gh-release` v3.0.1 = `718ea10b132b3b2eba29c1007bb80653f286566b`
- **No separate `build` step** — unlike the esbuild-based repos, `npm run package`
  (wireit) resolves the `bundle`/`build` dependencies itself, so packaging alone
  is enough. Verify locally that a clean `npm ci && npm run package` produces
  `out/packaged.vsix`.
- **Asset name:** wireit emits a fixed `packaged.vsix`; the `mv` step gives it a
  meaningful name on the Release. If the version guard is added, rename to
  `lit-plugin-<version>.vsix` for clarity.
- **Existing workflows are unaffected** — `workflow.yml` (Test) and
  `test_vscode.yml` (Integration) trigger on PR/push-to-master; this new one only
  triggers on tags. No overlap.

## How you'd use it (once implemented)

```bash
# 1. Bump the extension version in packages/vscode-lit-plugin/package.json
#    (and match the tag below, if a guard is added).
# 2. Commit, then tag and push:
git tag v1.4.4
git push origin v1.4.4
```

The action packages the extension and attaches `lit-plugin.vsix` to a new Release
with auto-generated notes. Users install via
`code --install-extension lit-plugin.vsix` (or Extensions view → "Install from
VSIX").

> Note: if a Release for that tag already exists, `softprops/action-gh-release`
> updates it in place (overwriting notes/asset) rather than failing.

## Implementation checklist

- [ ] Decide Node version (fill in above; recommended: 16 until lerna is replaced).
- [ ] Resolve the OPEN version-guard question.
- [ ] Verify locally: `npm ci && npm run package` on the chosen Node version
      produces `packages/vscode-lit-plugin/out/packaged.vsix`.
- [ ] Write `.github/workflows/release.yml` from the draft with the two decisions applied.
- [ ] (Optional, long-term) Migrate lerna 4 → npm workspaces/pnpm so CI can use a
      supported Node version; then raise `node-version` and remove the constraint note.

```

```
