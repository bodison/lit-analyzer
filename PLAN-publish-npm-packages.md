# Plan: Publish the fork's npm packages (Track A — `lit-analyzer` + `ts-lit-plugin`)

**Created:** 2026-06-09
**Status:** Not Started

## Overview

Rescope and publish the two npm packages of this fork (`lit-analyzer` core/CLI and `ts-lit-plugin`) under a namespace we control, so the muniworth consumer (and others) can install them from a registry instead of the vendored tarball.

## Context

The original names `lit-analyzer` and `ts-lit-plugin` are owned by `runem` on npm — the fork **cannot** republish to them and must rescope (e.g. `@muniworth/…`). The repo is MIT, so the fork is permitted; keep `LICENSE`/attribution. The consumer already works off `vendor/lit-analyzer-2.0.3.tgz`, so npm is only needed for shareable/CI-friendly distribution.

**Key Files:**

- `packages/lit-analyzer/package.json` — name `lit-analyzer` v2.0.3; `bin.lit-analyzer` → `cli.js`; `main` `index.js`; `files` allowlist (`/lib/`, `index.js`, `index.d.ts`, `cli.js`); `prepublishOnly: npm test`; `repository` → runem.
- `packages/ts-lit-plugin/package.json` — name `ts-lit-plugin` v2.0.2; depends on `lit-analyzer: ^2.0.1`.
- `packages/lit-analyzer/readme.blueprint.md` + `readme.config.json` — README is generated; never edit `README.md` directly.
- Root `package.json` — `publish` script uses `lerna publish` (lerna 4); `postinstall` runs `lerna bootstrap`.
- `lerna.json` — lerna v4 config; `nohoist` for `typescript`.
- Memory `build-toolchain-gotchas`: Node only via `devenv shell --`; lerna bootstrap/publish broken on Node 26; build pinned to `node_modules/typescript/bin/tsc`.

**Dependencies:** npm account + auth (token or `npm login` with 2FA/OTP), or a private registry / GitHub Packages target. Node 26 via `devenv shell --`. The fork's pinned TypeScript for building.

## Phases

### Phase 0: Decide naming, registry, and access

**Goal:** Lock the three decisions that everything else depends on.
**Steps:**

- [ ] Choose the npm **scope** (recommended `@muniworth`; alt `@bodison`) and record it.
- [ ] Choose the **registry/access**: public npm (`--access public`), a private registry, or GitHub Packages (`@scope` mapped to `npm.pkg.github.com`).
- [ ] Decide whether to keep `prepublishOnly: npm test` (full suite incl. headful, won't pass headless) or bypass per publish.
      **Verify:** Decisions written into this plan's header; `npm whoami` (or registry auth) succeeds against the chosen registry.

### Phase 1: Rescope the package manifests

**Goal:** Rename both packages and fix the inter-package dependency so they resolve under the new scope.
**Steps:**

- [ ] In `packages/lit-analyzer/package.json`: change `name` to `@<scope>/lit-analyzer`; add `publishConfig.access` = `public` (scoped pkgs default to restricted); update `repository.url` to the fork (`bodison/lit-analyzer`).
- [ ] In `packages/ts-lit-plugin/package.json`: change `name` to `@<scope>/ts-lit-plugin`; change the `dependencies.lit-analyzer` entry to `@<scope>/lit-analyzer` at the new version range; update `repository.url`.
- [ ] If targeting GitHub Packages: add a `publishConfig.registry` (or repo `.npmrc`) mapping `@<scope>` to the GitHub registry.
      **Verify:** `npm pkg get name` in each package prints the scoped names; `npm pkg get dependencies` in `ts-lit-plugin` shows the scoped `lit-analyzer` dependency.

### Phase 2: Build both packages (bypassing broken lerna bootstrap)

**Goal:** Produce publishable artifacts without the Node-26 lerna path.
**Steps:**

- [ ] Ensure per-package deps are installed (install in `packages/lit-analyzer` and `packages/ts-lit-plugin` directly — root `lerna bootstrap` is broken on Node 26).
- [ ] Build `packages/lit-analyzer` with the pinned compiler (`node node_modules/typescript/bin/tsc --build --pretty`); confirm `cli.js`, `index.js`, `lib/` emit.
- [ ] Build `packages/ts-lit-plugin` (its `wireit build` depends on `lit-analyzer:build`; with bootstrap broken, build `lit-analyzer` first and make it resolvable — workspace symlink or local install — then build).
      **Verify:** `npm pack --dry-run` in `packages/lit-analyzer` lists `cli.js`, `index.js`, and `lib/`; same in `packages/ts-lit-plugin` lists `index.js`/`lib/`.

### Phase 3: Regenerate the generated READMEs for the new names

**Goal:** Keep published READMEs accurate after the rename (they are generated, not hand-edited).
**Steps:**

- [ ] Update name references in the README sources (`packages/lit-analyzer/readme.blueprint.md` / `readme.config.json`, and the ts-lit-plugin equivalents) to the scoped install commands.
- [ ] Regenerate via the package `readme` script (`readme generate -i readme.blueprint.md -c readme.config.json`).
      **Verify:** Generated `packages/lit-analyzer/README.md` shows the `@<scope>/lit-analyzer` install line; no manual edits to `README.md` remain.

### Phase 4: Publish `@<scope>/lit-analyzer` (core first)

**Goal:** The core package is live on the chosen registry.
**Steps:**

- [ ] Bump version in `packages/lit-analyzer/package.json` (e.g. `npm version patch`).
- [ ] Authenticate (`npm login` or token in `.npmrc`).
- [ ] Publish from the package dir (`npm publish --access public`; add `--ignore-scripts` if bypassing `prepublishOnly`); enter OTP if 2FA.
      **Verify:** `npm view @<scope>/lit-analyzer version` returns the published version; a clean `npm pack @<scope>/lit-analyzer` from a temp dir downloads it.

### Phase 5: Publish `@<scope>/ts-lit-plugin`

**Goal:** The TS-plugin package is live and points at the published core.
**Steps:**

- [ ] Set `dependencies.@<scope>/lit-analyzer` in `packages/ts-lit-plugin/package.json` to the exact version published in Phase 4.
- [ ] Rebuild (Phase 2) to confirm it resolves against the published/installed core.
- [ ] Bump version and `npm publish --access public` from the package dir.
      **Verify:** `npm view @<scope>/ts-lit-plugin dependencies` shows the scoped core at the published version; `npm view @<scope>/ts-lit-plugin version` returns the new version.

### Phase 6 (optional): Cut the muniworth consumer over to the published package

**Goal:** Replace the vendored tarball dependency with the registry package.
**Steps:**

- [ ] In `lit-analyzer-mw/package.json`, change the `lit-analyzer` devDependency from `file:vendor/lit-analyzer-2.0.3.tgz` to `@<scope>/lit-analyzer` at the published version; remove `vendor/lit-analyzer-2.0.3.tgz`.
- [ ] Reinstall; the `bin` is now `@<scope>/lit-analyzer` — confirm the `typecheck-lit` script still resolves the `lit-analyzer` binary (the bin name is unchanged) or adjust the script.
      **Verify:** `npm run typecheck-lit` in the consumer still reports the `TxHistory` `type="month"` warnings with no crash.

## Testing

1. From a scratch directory, install each published package and confirm import/CLI works: `npx @<scope>/lit-analyzer --help` prints usage; `require("@<scope>/ts-lit-plugin")` loads.
2. `npm view` on both packages shows correct version, `repository`, and (for ts-lit-plugin) the scoped core dependency.
3. Consumer end-to-end (if Phase 6 done): `typecheck-lit` is green-of-crashes and still catches `type="month"`.

## Notes / risks

- **`lerna publish` is unusable on Node 26** (same broken bundled `yargs` as `lerna bootstrap`) — publish per-package by hand as above, not via the root `publish` script.
- **`prepublishOnly: npm test`** will try to run headful VS Code tests; publish with `--ignore-scripts` or trim the hook in the fork.
- This track is **independent of the VS Code extension** (Track B bundles from source and needs no npm publish).
