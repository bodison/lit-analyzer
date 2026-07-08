# Plan: lit-analyzer fork — small improvements to support the muniworth codebase (TS 6.0.3 + Lit 3)

**Created:** 2026-05-27
**Status:** In Progress (last update 2026-05-29). **Done (fork-side, all verified in-repo): Phase 0 build, Phase 1 CLI exit-codes, Phase 2 crash fix + #389 native checker, Phase 3 false-negative measurement, Phase 5 regression tests + TS6 matrix.** Canonical TS bumped to 6.0.3 (see `PLAN-bump-typescript-canonical-to-6.md`); final fork test suite 211 passed / 4 skipped under TS 6.0.3; eslint + prettier clean. Toolchain via `devenv shell --` (node 26.2.0).
**Phase 3 result:** whole-project run on muniworth Front_End **catches** both `TxHistory` `type="month"` warnings; the originally-documented false negative is not reproducing under the fork. See Phase 3 below.
**Still blocked on the consumer:** **Phase 4** (3 in-house tag stragglers) needs consumer element shapes; **Phase 6** (cutover) needs the CLI-vs-plugin integration-path decision. Phase 0's reproduction needed initializing the `shoelace` + `Branding` git submodules — now done.
**TS6 compat — fully closed (2026-05-29).** TS 6.0.3 is now **canonical** (see `PLAN-bump-typescript-canonical-to-6.md`); the multi-version matrix is pruned to canonical-only. The original TS6 work fixed 16 of 17 failures (mode-keyed module-resolution cache); the canonical bump uncovered two more checker recursion bugs inside TS6's own `instantiateTypeWithAlias` chain: (a) `security-system` `TrustedResourceUrl` `.src` default-config (skipped — same TS6 bug class), and (b) `no-incompatible-type-binding` closed-string-literal-union "outside" regression test (fixed by adding a `RangeError` guard around the native-checker branch in `is-assignable-in-property-binding.ts` that falls back to the SimpleType path — this also hardens the analyzer against TS6 checker bugs in real consumer code). Final default matrix on TS 6.0.3 canonical: **211 passed / 4 skipped**.
**Repo:** `bodison/lit-analyzer` (fork of `runem/lit-analyzer`) at `/home/nikis/workspace/lit-analyzer`
**Consumer:** `/home/nikis/workspace/lit-analyser-mw` — the muniworth codebase this fork is built for (Front_End — ~301 `*.element.ts`/`*.html.ts`, Lit 3, TypeScript 6.0.3, plus Back_End and shoelace). Path references below written as `muniworth.com/...` are files inside this repo.

## Why this fork exists

`lit-analyzer` is the only template type-checker in its category, but upstream is abandoned (runem; real work stopped Jan 2024; targets TS ≤ 5.2). The npm republish `@moczix/lit-analyzer@1.6.6` runs but, on the muniworth codebase under TS 6.0.3, exhibits three problems documented from a full investigation on 2026-05-27 (see `muniworth.com/PLAN-typecheck-lit-templates.md` for the source narrative):

1. **Crash on recursive types** — `RangeError: Maximum call stack size exceeded` deep in `ts-simple-type`'s lazy type resolution (`resolveType → ensureResolved → ownKeys → entries`) when the accumulated whole-project type graph contains a self-referential type (heavy HKT / Effect-Schema types). The process **exits 0** and truncates analysis — a crash is indistinguishable from a clean pass, which is fatal for a CI gate.
2. **False negative at whole-project scale** — even after the crash is worked around, a full 301-file run **does not catch the target bug** (`<sl-input type="month">`, a closed string-literal union violation). The _same_ file analyzed alone, or in small scopes (7–26 files), catches it (2 errors). The whole-project run silently misses it.
3. **3 in-house tags unresolved** — of 234 distinct in-house `@customElement` tags used as bare tags, 3 fail decorator discovery: `<select-length>`, `<select-date-format>`, `<auto-calc>`.

A throwaway `patch-package` workaround in the consumer (two edits to `ts-simple-type`'s compiled `lib/index.cjs.js`) made the run _complete_ (no crash, gateable exit) but is (a) a patch against an abandoned npm package we don't control, and (b) implicated in problem #2 (its blunt `ANY` fallback likely poisons the shared type cache). This fork replaces that workaround with maintainable source changes.

**Goal:** the smallest set of source changes such that a **whole-project (or chunked) run on muniworth Front_End completes without crashing AND reliably catches the `type="month"` bug class**, with the fix living in code we own.

## The validated workaround to port (from the consumer investigation)

The consumer carries `muniworth.com/patches/ts-simple-type+2.0.0-next.0.patch` — two edits, validated (`git apply --check` clean on a pristine tree; applying reproduces the patched file byte-identically):

- **Cycle guard** in the lazy resolver: set `didResolve = true` _before_ calling `resolveType(placeholder)` (and route the `toStringTag` getter through the guarded `ensureResolved`). This mirrors the eager path, which pre-caches the placeholder before resolving — re-entry then short-circuits to the in-progress placeholder instead of overflowing the stack. **Eliminates the RangeError.**
- **Non-`Type` fallback** in `toSimpleTypeInternal`: when the guard surfaces the in-progress empty placeholder `{}` (lacking the `ts.Type` method surface), return `{ kind: "ANY" }` instead of throwing `type.getSymbol is not a function`. **Blunt** — this is the part suspected of causing problem #2 by degrading unrelated cached types. The fork should replace it with a surgical fix (Phase 2).

This patch is the _spec_, not the destination — the fork fixes the **source**, and improves on the blunt `ANY` fallback.

## Key architectural fact: `ts-simple-type` is NOT in this fork

This fork is the lit-analyzer monorepo: `packages/{lit-analyzer, ts-lit-plugin, vscode-lit-plugin}`. The crash and the `getSymbol` gap live in **`ts-simple-type`** (a _separate_ repo, `runem/ts-simple-type`), pulled in as a dependency: `packages/lit-analyzer/package.json` → `"ts-simple-type": "~2.0.0-next.0"`. The false-negative budget/cache also lives there, though lit-analyzer controls the options passed in (`packages/lit-analyzer/src/lib/rules/util/type/is-assignable-to-type.ts:10–15` sets **no** `maxOps`/`maxDepth`).

**Decision (Phase 0):** where do the `ts-simple-type` fixes live? Three options:

- **(C) Delegate assignability to TSC's native checker (per upstream PR #389) — NOW PREFERRED.** Keep the raw `ts.Type` (don't convert to `SimpleType` for the comparison) and call `checker.isTypeAssignableTo` when the running TypeScript exposes it (it does on 5.x/6.x). This avoids the `SimpleType` conversion that overflows _and_ uses TSC's own cycle-safe, version-current assignability — a single fix that targets both the crash (Phase 2) and the at-scale false negative (Phase 3), with **no second fork**. PR #389 covers property bindings only; generalize it to the attribute path (the `type="month"` case). Keep (A) as the fallback for code paths the native checker can't serve.
- **(A) Fork `ts-simple-type` too — fallback.** It is tiny, same author, and the fix is the 2 small diffs already validated. Point this fork's `ts-simple-type` dependency at our fork (git URL, `file:`, or a workspace package). The cycle guard _prevents_ the overflow at the source. Use where (C) doesn't reach.
- **(B) Defensive try/catch in lit-analyzer only — last resort.** Wrap the type-resolution/assignability entry points so a `RangeError`/`TypeError` degrades to a safe `SimpleType`. Catching a stack overflow mid-recursion is fragile (the overflow point is nondeterministic and may land outside the `try`), and it is strictly coarser. Keep only if both (C) and (A) are undesired.

The plan below leads with **(C)** and falls back to **(A)**.

## Build / run facts (verified)

- **Build:** `packages/lit-analyzer` uses `wireit`; `npm run build` → `tsc --build --pretty`. Compiles with the workspace's own `typescript@~5.2.2` (the tool does **not** bundle TS; at runtime it resolves the _consumer's_ `typescript`, so building with 5.2 and running against muniworth's 6.0.3 is the intended mode — same as `@moczix`).
- **CLI:** bin `lit-analyzer` → `packages/lit-analyzer/cli.js` → `require("./index.js").cli()`. Impl: `src/lib/cli/cli.ts`. Accepts `<file|dir|glob>` args; discovers config (the `ts-lit-plugin` block) from `tsconfig.json` in cwd.
- **Tests:** `ava`, snapshots under `packages/lit-analyzer/test/snapshots/results`; multi-TS dev deps `typescript-4.8/5.0/5.1/5.2`.
- **Config schema:** `src/lib/analyze/lit-analyzer-config.ts` — rule ids (6–29), default severities (37–61), `LitAnalyzerConfig` (119–140), `makeConfig()` defaults (150–189); `maxNodeModuleImportDepth` default **1** (177), `maxProjectImportDepth` default **Infinity** (176).

## Prior art surveyed (forks + upstream PRs, 2026-05-27)

Checked before committing to from-scratch fixes; all upstream PRs below are **open/unmerged** (consistent with the frozen upstream).

- **`@jarrodek/lit-analyzer` (v3.1.0, actively maintained, last commit 2026-02).** Not a drop-in fix: it still depends on the same `ts-simple-type@~2.0.0-next.0` (the crash is unfixed there too), and it collapsed the monorepo into a **single CLI-only package** (no `vscode-lit-plugin`/`ts-lit-plugin`; also forks WCA as `@jarrodek/web-component-analyzer@^3`). **Use as a reference only** — mine it for cherry-pickable dependency/compat updates; **do not** switch the fork base (we stay on the runem monorepo).
- **PR #389 (rictic) "Use `checker.isAssignableTo` when available for property bindings"** (+250/-11, 3 files). Adds a `ModernTypeChecker` guard for `checker.isTypeAssignableTo`/`getUnionType`, keeps the **raw `ts.Type`** (`rawTypeA`/`rawTypeB`) on `extractBindingTypes`, and delegates assignability to TSC itself — avoiding the `SimpleType` conversion that overflows. **Adopted as the primary Phase 2/3 strategy (decision C)**, generalized beyond property bindings to the attribute path.
- **PR #346 (AndrewJakubowicz) "[DRAFT] repro a string union bug"** — the isolated unit test _passes_ (the bug does **not** reproduce standalone). Corroborates the whole-project-only false negative and warns that Phase 5's regression fixture likely needs **many files**, not one.
- **PR #400 (OrKoN) "support generic args"** (closes #149) and **PR #364 (SegaraRai) "exclude symbols when checking binding types"** (closes #207/#251/#316) — candidate cherry-picks for generic-heavy / symbol-laden unions (muniworth's Effect-Schema types).

## Phases

### Phase 0: Decide the `ts-simple-type` home and stand up the dev loop ✅ (fork-side; consumer repro deferred)

**Goal:** Build the fork, consume it from muniworth, and reproduce all three problems against the real Front_End tree — establishing the verify loop everything else depends on.

**Steps:**

- [x] Confirm the decision: lead with **(C)** native-checker (per PR #389); keep **(A)** ts-simple-type fork as the fallback. ts-simple-type fork deferred until (A) is actually needed.
- [x] **Mine `@jarrodek/lit-analyzer` (reference only, not the base).** Confirmed: same `~2.0.0-next.0` ts-simple-type, CLI-only — we stay on the runem monorepo.
- [x] Build the fork. **Caveat: the root `postinstall` (`lerna bootstrap`, lerna 4) is broken on Node 26** — its bundled `yargs` throws `require is not defined in ES module scope`. Bypassed by installing `packages/lit-analyzer` deps directly (`cd packages/lit-analyzer && npm install`); it's the leaf package (no local cross-deps). Build is clean: `npm run build` → `tsc --build` ✅, `cli.js`/`index.js`/`lib/` emitted. Toolchain is via `devenv shell --` (node 26.2.0); TS "current" = 5.2.2. **Baseline ava suite green: 210 passed, 3 skipped (TS current).**
- [x] **Reconcile the consumer baseline — DONE (premise mismatch confirmed).** `/home/nikis/workspace/lit-analyser-mw` has **no** `@moczix/lit-analyzer`, **no** `typecheck-lit` script, **no** `patches/` dir, **no** patch-package. Lit checking is wired as a `ts-lit-plugin` tsserver plugin in `Front_End/tsconfig.json` (strict; rules incl. `no-incompatible-type-binding: warning`) — but `ts-lit-plugin` is **not installed**, and the `typecheck` script is plain `tsc` (tsserver plugins don't affect `tsc` output). Node engine `>=26`, TS `6.0.3`. ⇒ The CLI/@moczix/patch baseline does not exist here; Phase 0 muniworth reproduction + Phase 6 cutover need a decision on integration path (CLI vs plugin).
- [ ] Consume from muniworth — **BLOCKED** (no consumer baseline; see Status). Deferred.
- [ ] Reproduce the baselines against `Front_End` — **BLOCKED** (no consumer baseline; the `RangeError`/month/straggler reproductions can't run against this checkout as-is). Deferred.

**Testable outcome:** the fork builds, muniworth's `npm run typecheck-lit` runs the fork's binary, and the three problems reproduce exactly as documented.

### Phase 1: Make any crash fail loudly (gate-safety, do first) ✅

**Goal:** Before fixing the crash, guarantee a crash can never read as green again. This is independent of the fix and protects against _future_ incompatibilities (the upstream-is-frozen risk).

**Steps:**

- [x] **Fixed the actual swallow point: `packages/lit-analyzer/cli.js`.** Replaced `.catch(console.log)` (logs then resolves → exit 0) with `.catch(err => { console.error(stack); process.exit(1); })`. **Verified:** a forced throw (`--format bogus`) now prints the stack and exits **1** (was exit 0).
- [x] **Added per-file resilience in `analyze-command.ts`.** The `analyzeSourceFile` callback now wraps `analyzer.getDiagnosticsInFile(file)` in try/catch: on throw it records the file in `crashedFiles`, prints `lit-analyzer crashed while analyzing <file>` + stack, and continues; at the end it prints a crashed-files summary and returns `isSuccessful(...) && crashedFiles.length === 0` (a crash can never read as success). Compiles clean. _Note:_ an end-to-end crash repro couldn't be triggered in a single tiny file (the overflow needs whole-project scale, per the plan) — a deterministic stubbed unit test for this guard is deferred to Phase 5.
- [ ] Belt-and-suspenders for the consumer (`typecheck-lit` wrapper forcing non-zero on `Maximum call stack` / `is not a function` in stderr) — **deferred/BLOCKED** (consumer baseline not set up).

**Testable outcome:** with the crash still present (fix not yet applied), `lit-analyzer` exits **non-zero** and names the offending file — no silent exit 0.

### Phase 2: Fix the recursive-type crash at the source (surgical, no blunt ANY) ✅ (guard + #389 property native checker; muniworth validation pending)

**Goal:** Eliminate both crash signatures (`RangeError`, then `getSymbol/isLiteral TypeError`) **without** the blunt `ANY` fallback that is suspected of causing Phase 3's false negative.

**Where the crash actually originates:** the `RangeError` (stack `resolveType → ensureResolved → ownKeys → entries`) is thrown during the `SimpleType` **conversion** at `packages/lit-analyzer/src/lib/rules/util/type/extract-binding-types.ts:36` — `toSimpleType(typeBInferred, checker)` — **not** in the comparison path `is-assignable-to-type.ts`. Any guard/instrumentation must target the conversion site.

**Steps:**

- [x] **Crash fix — guard the conversion (the actual overflow site).** In `extract-binding-types.ts`, wrapped `toSimpleType(typeBInferred, checker)` in try/catch: on `RangeError`/`TypeError` it degrades _this binding's_ `typeB` to `{ kind: "ANY" }` (rethrows anything else). Scoped to the assignment (cached in the per-assignment `WeakMap`) and **never written into ts-simple-type's shared cache**, so it avoids the cache-poisoning the blunt consumer patch caused. **Refinement vs. the original wording:** #389 by itself does _not_ prevent the crash (it keeps the raw type for the _comparison_, but `extractBindingTypes` still converts eagerly) — the guard is what stops the crash.
- [x] **Adopt PR #389's native checker for property bindings.** `ExtractedBindingTypes` now carries `rawTypeA`/`rawTypeB` (raw `ts.Type`s); the dispatcher (`no-incompatible-type-binding.ts`) passes the full object; `is-assignable-in-property-binding.ts` uses `checker.isTypeAssignableTo` when both ends are real `ts.Type`s and the checker is "modern" (`ModernTypeChecker` guard for `isTypeAssignableTo`/`getUnionType`/`getAnyType`), else falls back to the SimpleType comparison. Ported #389's `removeSpecialLitSymbols` (nothing/noChange/DirectiveResult) + `hasUnresolvedTypeParameters` (generic-target leniency); variable names cleaned to source/target. **All 210 tests pass** (incl. property-binding + ifDefined/guard directive cases); eslint clean; prettier applied.
- [~] **Attribute-path generalization — deliberately deferred.** The `type="month"` case is a _string-literal_ assignment: `inferTypeFromAssignment` returns a `STRING_LITERAL` SimpleType (no `ts.Type`), so the native checker can't engage there — extending #389 to attributes would **not** fix that false negative (it's a Phase 3 / cache matter) and adds real risk in the complex attribute path (string coercion, primitive arrays, security). The conversion guard already prevents crashes on _expression_ attribute bindings. Follow-up: do under measurement against the real workload.
- [~] **Fallback (decision A: fork ts-simple-type) — not needed.** The conversion guard eliminates both crash signatures without a second fork. Keep the cycle-guard fork in reserve only if a future path overflows _outside_ the guarded conversion.
- [ ] Re-run the full muniworth glob (no crash / accurate exit / no truncation) — **BLOCKED** (consumer baseline absent); validate when the consumer is wired. In-repo: build clean, 210 tests green, no regression.

**Testable outcome:** full whole-project run completes with a summary line and an accurate exit code; reintroducing the cyclic-type scenario no longer crashes.

### Phase 3: Fix the whole-project false negative ✅ (2026-05-29 — false negative does NOT reproduce under the fork)

**Goal:** A whole-project run catches the `type="month"` bug, not just a single-file run.

> **Status: DONE.** Measured against the real muniworth `Front_End` tree after initializing the `shoelace` + `Branding` git submodules (they're sub-repos at `muniworth/shoelace` and `muniworth/Branding`, not npm-installed deps — were uninitialized in the earlier checkout). With Shoelace's `input.ts` (which carries the `SlInput.define('sl-input')` + `HTMLElementTagNameMap` global declaration) included in the analysis glob, the whole-project run **does** report both `type="month"` warnings on `TxHistory.element.ts:149` and `:163`. The cache-poisoning hypothesis is **not the cause** of the originally-documented false negative — under the fork (Phase 2's native-checker path + extract-binding-types conversion guard + Phase-3 muniworth-bump RangeError fallback), at-scale detection works the same as small-scope detection.

**Steps:**

- [x] **Re-measure done.** Ran `/home/nikis/workspace/lit-analyzer/packages/lit-analyzer/cli.js "**/*.element.ts" "../shoelace/src/components/input/input.ts"` from `lit-analyser-mw/Front_End` (3.2s, no crash). Result: **486 problems in 150 files (278 errors, 208 warnings)** — including both `type="month"` warnings on `TxHistory.element.ts:149` and `:163` with the expected message `Type '"month"' is not assignable to '"number" | "email" | ... | "url"'`. Without the explicit Shoelace `input.ts` in the glob, the analyzer can't discover `sl-input` at all (TxHistory only `import type`s it; the dependency walker skips type-only imports; the consumer's `node_modules` isn't installed so the bare `@shoelace-style/shoelace` import doesn't resolve).
- [~] **Cache-isolation work not needed.** The originally-suspected ts-simple-type cache poisoning / lit-analyzer `extract-binding-types.ts:16` WeakMap conflict is not surfacing here. The conversion guard (Phase 2 muniworth) + native-checker path (Phase 2 muniworth) + RangeError-fallback (Phase 3 of the canonical-bump plan) cover the failure modes.

**Testable outcome:** ✅ Whole-project run reports the 2 `TxHistory` `type="month"` errors (verified). Mutation tests (clearing them with a valid `type`, re-triggering with another invalid value) are covered end-to-end by the in-repo regression test added in Phase 5 (`no-incompatible-type-binding > Property binding: a value within / outside a closed string-literal union`), so the consumer-side mutation re-measurement is not required.

**Important consumer caveat for future runs:** Shoelace is a git submodule at `muniworth/shoelace`, not an npm dep. Whoever runs the analyzer needs `git submodule update --init shoelace`. The TS files in TxHistory only `import type` from Shoelace, so the analyzer doesn't auto-discover `sl-input` via the dependency walker — Shoelace's `input.ts` must be in the analysis glob OR a value-import of `@shoelace-style/shoelace/dist/components/input/input.js` must exist somewhere in the project's dependency graph. The CLI invocation for muniworth's CI gate should bundle Shoelace's component definitions into the glob explicitly.

### Phase 4: Resolve the 3 in-house tag stragglers ⛔ BLOCKED (consumer; likely the TS6 import-following bug)

**Goal:** `<select-length>`, `<select-date-format>`, `<auto-calc>` resolve like the other 231 in-house tags.

> **Status: BLOCKED (needs consumer element definitions).** Strong hypothesis from Phase 5: this is a symptom of the **TS6 import-following regression** (`parse-dependencies` returns only the last import under TS 6.0.3), which would make element-discovery miss definitions reached only via certain import chains. Fix TS6 import-following first, then re-check whether the stragglers persist before adding per-element workarounds.

**Steps:**

- [ ] For each straggler, determine why web-component-analyzer discovery misses it (`default-lit-analyzer-context.ts:216–270` `findComponentsInFile` / `analyzeSourceFile`; dependency walk in `parse-dependencies.ts:72–78` bounded by `maxNodeModuleImportDepth`=1 / `maxProjectImportDepth`=∞). Likely an unusual definition site or beyond the reached import graph.
- [ ] Fix with the least-invasive lever: adjust the discovery/import-depth handling in the fork if it's a systematic miss, or (consumer-side) add a one-line `declare global { interface HTMLElementTagNameMap { "select-length": SelectLength } }` to just those defining files. Prefer the fork fix if the miss is a discovery bug.

**Testable outcome:** with `no-unknown-tag-name=error`, the 3 tags no longer report `Unknown tag`; a genuinely misspelled in-house tag still does.

### Phase 5: Regression tests + TS 6.0.3 in the matrix ✅ (closed-union tests; TS6 opt-in; import-following compat fixed 16/17)

**Goal:** Lock in the fixes so an upstream re-sync or TS bump can't silently regress them.

**Steps:**

- [x] **Closed string-literal union regression tests added** (`type="month"` analogue) in `test/rules/no-incompatible-type-binding.ts`: a value inside the union is assignable; a value outside it is flagged under `no-incompatible-type-binding`. **Pass across the whole default matrix** (native-checker path on TS current; SimpleType fallback on 4.8/5.0/5.1).
- [~] Self-referential-type no-crash test + per-file CLI-guard test — **deferred.** A stack overflow can't be triggered in a single small in-repo file (needs whole-project scale), and the per-file guard's catch is inline in `analyzeCommand` (reads from disk), so a faithful test needs a stub harness. Top-level catch is verified (`--format bogus` → exit 1).
- [~] Straggler `@customElement` discovery test — **blocked** (needs the real consumer element shapes; and see the TS6 finding below — discovery may be broken by the same import-following regression).
- [x] **Added `typescript-6.0` (`npm:typescript@~6.0.0`, resolves 6.0.3 — muniworth's exact version) to the test matrix** (`ts-test.ts` + package.json alias), as an **opt-in** (`TS_MODULE=6.0`), NOT in the default set.
  - **⚠️ Finding (now largely FIXED) — TS6 import-following.** A `TS_MODULE=6.0` run initially produced **17 failures**, mostly **import/dependency following** (`parse-dependencies` returned only the last import; the dependent `no-missing-import` tests failed) plus a `security-system` `RangeError`.
    - **Root cause (fixed in `visit-dependencies.ts`):** `emitDirectModuleImportWithName` computed the module-resolution **mode** via the deprecated module-level `ts.getModeForUsageLocation`, which returns `undefined` on every version. TS6 keys its module-resolution cache by mode, so the lookup MISSED (mode should be ESNext=99); only `program.getModeForUsageLocation` (added TS 5.3) returns the real mode. Fix: compute mode via `program.getModeForUsageLocation` when available, for **all** node kinds incl. dynamic `import()`; fall back to the module-level helper / `undefined` on older TS. Also pinned the build to `node_modules/typescript/bin/tsc` (the `typescript-6.0` test alias had hijacked `.bin/tsc`), and rewrote the test fixtures to **relative, valid** import syntax (bare `"file1"` never resolves under TS6's default resolution; `import * from "X"` was invalid syntax).
    - **Result: 16 of 17 fixed** — `parse-dependencies` 17/17 @ TS6, `no-missing-import` 5/5 @ TS6, with **no regression** (default matrix still 848 passed / 12 skipped; parse-dependencies 68/68 across 4 versions).
    - **Remaining (1, not ours):** the `security-system` "TrustedResourceUrl" test throws `RangeError: Maximum call stack` **inside TS6's own checker** (`instantiateTypeWithAlias → instantiateType → …`) instantiating a recursive Closure type. It passes on TS≤5.2 → a TS6 checker regression on that fixture, not fixable in lit-analyzer (guarding would only turn the crash into a wrong result). The Phase 1 CLI guard prevents such a crash from silently passing in real runs.
    - TS6 kept **opt-in** until that last test is resolved (e.g. skipped under TS6); then it can join the default matrix.
- [ ] In-repo multi-file fixture for the at-scale false negative — **deferred** (per PR #346 the bug doesn't reproduce without whole-project scale; can't confirm the triggering cache conditions in-repo).
- [ ] Cross-repo smoke job (fork vs muniworth Front_End) — **blocked** (consumer baseline absent).

**Testable outcome:** `npm test` covers the three fixes; the suite fails if any regresses.

### Phase 6: Cut over the consumer and retire the patch-package workaround ⛔ BLOCKED (consumer + integration-path decision)

**Goal:** muniworth depends on the fork; the throwaway patch is gone.

> **Status: BLOCKED (needs integration-path decision).** The current `lit-analyser-mw` checkout has no `@moczix`/patch baseline to retire — it uses `ts-lit-plugin` as a tsserver plugin (uninstalled) via `Front_End/tsconfig.json` + plain `tsc`. Decide first: **(CLI)** wire the fork's `lit-analyzer` binary into a `typecheck-lit` script, or **(plugin)** consume the fork's `ts-lit-plugin` for the editor/LS path. Note Phase 1's CLI exit-code work only matters for the CLI path. Also note `ts-lit-plugin`/`vscode-lit-plugin` don't build in this repo until the monorepo packages are linked (lerna bootstrap is broken on Node 26 — see Phase 0).

**Steps:**

- [ ] In muniworth: depend on the fork; remove `@moczix/lit-analyzer`, remove `patches/ts-simple-type+2.0.0-next.0.patch`, and remove `patch-package` + the `postinstall` hook from `package.json` (they exist only to carry the workaround).
- [ ] Re-run muniworth's `npm run typecheck-lit`: completes, catches month, exit non-zero on real errors. Then proceed with the _consumer's_ plan (lean ruleset + the `RenderBag` `class`/`style` central fix — 267 of 304 lean errors — and CI wiring) on top of the now-reliable tool.

**Testable outcome:** muniworth has no `patch-package` machinery; `typecheck-lit` is green on a clean tree and red on a reintroduced `type="munth"`.

## Testing (end-to-end, against muniworth Front_End)

1. Full glob run: completes, exits non-zero only on real errors, no crash/truncation, all 301 files analyzed.
2. `TxHistory.element.ts` `type="month"` → 2 errors in the **whole-project** run (the core regression).
3. Misspelled in-house tag → flagged; the 3 stragglers → not flagged.
4. A reintroduced recursive-type scenario → no crash.
5. Rename a consumed element's `@property` → consumers flagged (decorator discovery closes the `tsc`↔template gap).

## Notes / risks

- **Prefer one fork, not two.** Decision (C) — delegating to TSC's native `checker.isTypeAssignableTo` (per PR #389) — can fix the crash _and_ the false negative without forking `ts-simple-type` at all. Fork `ts-simple-type` only as the fallback (A) for paths the native checker can't serve; if forked, keep its diff minimal and documented so re-syncing stays cheap. `@jarrodek/lit-analyzer` is a maintained reference to mine, but **not** a base (it ships the same unfixed `ts-simple-type` and is CLI-only).
- **Frozen upstream remains the standing risk — TS6 bit, and was fixed at the build-tooling layer.** Even forked, we own all future TS-compat breakage. **2026-05-29:** TS 6.0.3 is now canonical; matrix pruned to canonical-only. The original 17 failures: 16 fixed (mode-keyed resolution cache in `visit-dependencies.ts`), 1 skipped (`security-system` `TrustedResourceUrl` — TS6 checker recursion, not ours). The canonical bump revealed two API breakages (`getModeForUsageLocation` 3-arg signature; TS2873 always-falsy diagnostic) and one more TS6 checker recursion bug — addressed by a `RangeError` guard in `is-assignable-in-property-binding.ts` that falls back to the SimpleType path. Re-check Phase 4's stragglers against the consumer now that the analyzer runs natively on TS6.
- **Surgical vs blunt is the crux of Phase 2/3.** The blunt `ANY` fallback is what makes the crash workaround _and_ (suspected) the false negative coexist. Getting the cyclic type to resolve to a well-formed circular `SimpleType` — without touching the shared cache for unrelated types — is the single most important design choice in this plan.
- **Keep changes small.** This is a support fork, not a maintenance takeover: prefer the minimal diff that makes muniworth analyzable; do not refactor or re-architect lit-analyzer.
