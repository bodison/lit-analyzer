# Plan: Publish the fixed VS Code extension (Track B — `vscode-lit-plugin`)

**Created:** 2026-06-09
**Status:** Not Started

## Overview

Re-identify and publish the fork's VS Code extension (currently `runem.lit-plugin`) under a publisher we control, bundling the fixed `ts-lit-plugin` + `lit-analyzer` so editor users get the TS6/Lit3 fixes. Distribution target: VS Code Marketplace, with optional OpenVSX and a no-store VSIX path.

## Context

The extension is built entirely from source via esbuild — it does **not** depend on the published npm packages, so this track is independent of Track A. Its marketplace identity is `<publisher>.<name>`; `runem.lit-plugin` is taken and must change. The only shared blocker with Track A is the Node-26 workspace-linking issue that breaks the cross-package `wireit` build dependencies.

**Key Files:**

- `packages/vscode-lit-plugin/package.json` — `name` `lit-plugin`, `private: true`, `publisher: runem`, `displayName` `lit-plugin`, `engines.vscode ^1.63.0`, `main` `bundle.js`; `contributes.typescriptServerPlugins` = `[{ name: "ts-lit-plugin", enableForWorkspaceTypeScriptVersions: true }]`; devDep `vsce ^2.7.0`.
- `packages/vscode-lit-plugin/esbuild.script.mjs` — bundles `src/extension.ts` → `built/bundle.js` and `../ts-lit-plugin/src/index.ts` → `built/node_modules/ts-lit-plugin/lib/index.js`; externals only `vscode`, `typescript`.
- `packages/vscode-lit-plugin/copy-to-built.js` — assembles `built/` (writes `built/package.json` from the package manifest with deps tweaked; copies `typescript` into `built/node_modules`, `LICENSE.md`, `README.md`, `docs/`, `syntaxes/`, `schemas/`).
- `packages/vscode-lit-plugin` wireit graph: `build` → (`../lit-analyzer:build`, `make-built-dir`); `make-built-dir` → (`../ts-lit-plugin:build`, `bundle`) then `node ./copy-to-built.js`; `package` → `cd built && vsce package -o ../out/packaged.vsix`; `publish` → `cd built && vsce publish`.
- Memory `build-toolchain-gotchas`: Node only via `devenv shell --`; lerna bootstrap broken on Node 26; build pinned to `node_modules/typescript/bin/tsc`.

**Dependencies:** `vsce` (or upgrade to `@vscode/vsce`); a Marketplace **publisher** + Azure DevOps **Personal Access Token** (Marketplace > Manage scope); optionally `ovsx` + an OpenVSX token. Node 26 via `devenv shell --`.

## Phases

### Phase 0: Decide identity and distribution channels

**Goal:** Lock publisher/name and which channels to ship to.
**Steps:**

- [ ] Choose the **publisher id** (must be a registered Marketplace publisher) and the extension **`name`** (marketplace id = `<publisher>.<name>`; `runem.lit-plugin` is taken — e.g. `lit-plugin-muniworth`).
- [ ] Decide channels: Marketplace only, +OpenVSX (for VSCodium/Cursor/Windsurf), or VSIX-only (internal).
- [ ] Decide whether to bump `engines.vscode` (currently `^1.63.0`).
      **Verify:** Decisions written into this plan's header.

### Phase 1: Make the monorepo build on Node 26 (shared blocker)

**Goal:** The cross-package `wireit` build dependencies (`../lit-analyzer:build`, `../ts-lit-plugin:build`) resolve so the extension can build.
**Steps:**

- [ ] Install deps for `packages/lit-analyzer` and `packages/ts-lit-plugin` directly (root `lerna bootstrap` is broken on Node 26).
- [ ] Establish the workspace links the bundle/build expect (esbuild reads `../ts-lit-plugin/src/index.ts` and `../lit-analyzer` build output; `ts-lit-plugin` resolves `lit-analyzer`) — via manual `node_modules` symlinks or local installs.
- [ ] Pin the build compiler to `node_modules/typescript/bin/tsc` where a `tsc` shadow could interfere.
      **Verify:** `npm run build` in `packages/vscode-lit-plugin` completes — `built/bundle.js` and `built/node_modules/ts-lit-plugin/lib/index.js` exist and `tsc --build` exits 0.

### Phase 2: Re-identify the extension

**Goal:** The extension carries our publisher/name/metadata, flowing into the packaged `built/package.json`.
**Steps:**

- [ ] In `packages/vscode-lit-plugin/package.json` set `publisher` to the chosen id, `name` to the chosen extension id, and update `displayName`, `description`, `repository`, `icon` as desired. (`private: true` is fine — `vsce` packages regardless.)
- [ ] Update README/marketplace copy via the README sources (generated; do not edit `README.md` directly), then regenerate.
- [ ] Leave `contributes.typescriptServerPlugins[0].name` as `ts-lit-plugin` — it refers to the **bundled** module in `built/node_modules`, not the npm package name; `copy-to-built.js` writes the matching `built/node_modules/ts-lit-plugin/package.json`.
      **Verify:** Run `make-built-dir` (`npm run build`), then `built/package.json` shows the new `publisher` + `name`; `built/node_modules/ts-lit-plugin/` exists so `vsce` won't flag it as extraneous.

### Phase 3: Package the VSIX and smoke-test locally

**Goal:** A loadable `.vsix` that surfaces the fixed diagnostics.
**Steps:**

- [ ] Run `npm run package` in `packages/vscode-lit-plugin` (→ `out/packaged.vsix`).
- [ ] Install locally: `code --install-extension out/packaged.vsix` in a clean profile.
- [ ] Open a Lit `.element.ts` file (e.g. from the muniworth tree) and confirm template diagnostics appear (e.g. the `type="month"` warning) with the workspace TypeScript 6.x.
      **Verify:** `out/packaged.vsix` exists; the installed extension shows lit-plugin diagnostics in the editor on a known-bad template.

### Phase 4: Create the publisher and authenticate

**Goal:** `vsce` can publish under our publisher.
**Steps:**

- [ ] Create an Azure DevOps organization and a **Personal Access Token** scoped to _Marketplace → Manage_.
- [ ] Register the publisher at the Marketplace manage portal (matching the `publisher` id from Phase 2).
- [ ] `vsce login <publisher>` (paste the PAT). Consider upgrading the devDep to `@vscode/vsce` if `vsce ^2.7.0` misbehaves on Node 26.
      **Verify:** `vsce ls-publishers` (or a `vsce verify-pat`) confirms the authenticated publisher.

### Phase 5: Publish to the Marketplace

**Goal:** The extension is live on the VS Code Marketplace.
**Steps:**

- [ ] Bump the extension `version`.
- [ ] Run `npm run publish` in `packages/vscode-lit-plugin` (→ `cd built && vsce publish`), or `vsce publish --packagePath out/packaged.vsix`.
      **Verify:** The extension appears at `marketplace.visualstudio.com/items?itemName=<publisher>.<name>`; `code --install-extension <publisher>.<name>` installs it from the store.

### Phase 6 (optional): Publish to OpenVSX

**Goal:** Availability in VSCodium/Cursor/Windsurf and other OpenVSX consumers.
**Steps:**

- [ ] Create an OpenVSX namespace + access token; add `ovsx` as a devDep.
- [ ] `npx ovsx publish out/packaged.vsix -p <token>`.
      **Verify:** The extension appears on `open-vsx.org` under the namespace.

## Testing

1. Fresh-profile install of the published extension; open a Lit template with a known violation → diagnostic shows (confirms the bundled `ts-lit-plugin`/`lit-analyzer` fixes are active).
2. Confirm it activates against a **workspace** TypeScript 6.x (`enableForWorkspaceTypeScriptVersions: true`) — the muniworth case.
3. Marketplace (and OpenVSX, if done) listing resolves and installs by `itemName`.

## Notes / risks

- **Independent of Track A** — the VSIX bundles `ts-lit-plugin` + `lit-analyzer` from source; no npm publish required.
- **Node-26 build linking (Phase 1) is the real gate** — same root cause as the broken `lerna bootstrap`; without it the `wireit` cross-package build deps won't resolve.
- **`vsce ^2.7.0` is old** — if it fails on Node 26, switch to `@vscode/vsce`.
- **No-store path:** `npm run package` alone yields `out/packaged.vsix` for `code --install-extension`, skipping the publisher/PAT setup entirely (good for internal distribution).
