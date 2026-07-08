# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Monorepo (Lerna + npm workspaces, orchestrated with [Wireit](https://github.com/google/wireit)) for tools that type-check and validate `lit-html` templates. Three published packages with a strict dependency chain:

```
vscode-lit-plugin  →  ts-lit-plugin  →  lit-analyzer
(VS Code extension)   (TS LS plugin)     (core engine + CLI)
```

- **`packages/lit-analyzer`** — The core analysis engine. Parses tagged templates, runs rules, produces diagnostics/completions/definitions. Also ships the `lit-analyzer` CLI.
- **`packages/ts-lit-plugin`** — Wraps the core engine as a TypeScript Language Service plugin (the thing that surfaces diagnostics in editors via `tsserver`).
- **`packages/vscode-lit-plugin`** — VS Code extension (`lit-plugin`) that bundles `ts-lit-plugin` plus TextMate grammars for syntax highlighting.

Almost all real logic lives in `lit-analyzer`. The other two packages are thin integration layers.

## Commands

Run from the repo root unless noted. Wireit resolves cross-package build dependencies automatically, so building/testing a downstream package builds its dependencies first.

| Task                                        | Command                                             |
| ------------------------------------------- | --------------------------------------------------- |
| Install                                     | `npm ci` (runs `bootstrap` via lerna automatically) |
| Build all packages                          | `npm run build`                                     |
| Full test suite (headless + headful + lint) | `npm test`                                          |
| Core unit tests only                        | `npm run test:headless` (= `lit-analyzer:test`)     |
| VS Code integration tests                   | `npm run test:headful`                              |
| Lint (eslint + prettier check)              | `npm run lint`                                      |
| Auto-fix formatting                         | `npm run prettier:write`                            |
| Watch core tests                            | `cd packages/lit-analyzer && npm run test:watch`    |

### Running a single core test

Tests use [AVA](https://github.com/avajs/ava) and run against **compiled `.js`** in `packages/lit-analyzer/test/` (not `src/`). Build first, then target a file or title:

```bash
cd packages/lit-analyzer
npm run build
npx ava test/rules/no-unclosed-tag.js          # one file
npx ava --match "*unclosed*"                    # by title substring
```

### TypeScript version testing

`tsTest` (in `src/test/helpers/ts-test.ts`) runs every test against the canonical TypeScript — currently `current` = **6.0.3** (matches muniworth's version). Test titles are prefixed `[ts<version>]`. The multi-version scaffolding (`TS_MODULES_ALL`, `TS_MODULES_DEFAULT`, `TS_MODULE` env var, `getCurrentTsModule`, `setupTest`/`setupTests`) is retained so re-adding versions is trivial — drop a `typescript-X.Y` alias into `package.json`, add `"X.Y"` to `TS_MODULES_ALL`, and (optionally) to `TS_MODULES_DEFAULT`. Currently only `current` is registered.

```bash
TS_MODULE=current npx ava test/rules/no-unclosed-tag.js
```

### Debugging in a live editor

- `npm run dev` opens a VS Code playground in `dev/` with `TSS_DEBUG=5999` (the marketplace `lit-plugin` is disabled there to avoid interference).
- `npm run dev:logs` tails `dev/lit-plugin.log`.
- Quick CLI smoke test: `cd packages/lit-analyzer && ./cli.js path/to/file.ts`.

## Architecture

### Analysis flow (lit-analyzer core)

`LitAnalyzer` (`src/lib/analyze/lit-analyzer.ts`) is the public entry point. Every public method (`getDiagnosticsInFile`, `getCompletionsAtPosition`, `getDefinitionAtPosition`, …) follows the same shape:

1. `context.setContextBase({ file })` then `context.updateComponents(file)`.
2. Find the tagged-template documents in the file (`HtmlDocument` / `CssDocument`).
3. Dispatch to `LitHtmlDocumentAnalyzer` or `LitCssDocumentAnalyzer`.

`LitAnalyzerContext` (`lit-analyzer-context.ts`, impl `default-lit-analyzer-context.ts`) is the dependency container threaded everywhere. It exposes the TS `program`, the `LitAnalyzerConfig`, the rule collection, and four **stores**:

- `htmlStore` — known HTML tags/attributes (built-in data merged with user config and analyzed components).
- `definitionStore` / `dependencyStore` — custom-element definitions and which files import them.
- `documentStore` — parsed template documents.

Component analysis (discovering custom elements, their members, attributes, events) is delegated to the external [`web-component-analyzer`](https://www.npmjs.com/package/web-component-analyzer) package; its `ComponentDefinition`/`ComponentDeclaration`/`ComponentMember` types flow through the rule system.

### Rule system

Rules live in `src/lib/rules/*.ts` and are registered in `src/lib/rules/all-rules.ts`. A rule implements the `RuleModule` interface (`src/lib/analyze/types/rule/rule-module.ts`): an `id`, optional `meta.priority`, and any subset of visitor methods:

- Document visitors: `visitHtmlNode`, `visitHtmlAttribute`, `visitHtmlAssignment`
- Component visitors: `visitComponentDefinition`, `visitComponentDeclaration`, `visitComponentMember`

`RuleCollection` (`src/lib/analyze/rule-collection.ts`) sorts rules by priority, then invokes the relevant visitor on every node/attribute/component. Inside a visitor, call `context.report({ location, message, ... })` to emit a diagnostic and `context.break()` to stop further rules for that node. Rule ids are the `LitAnalyzerRuleId` union in `lit-analyzer-config.ts`; each maps to a `lit-plugin.rules.<id>` setting.

**To add a rule:** create the rule module, add it to `ALL_RULES`, add its id to `LitAnalyzerRuleId`, add a test in `src/test/rules/`, and expose the setting in `packages/vscode-lit-plugin/package.json` under `contributes.configuration`.

### ts-lit-plugin integration

`src/index.ts` exports `init()`, the standard `tsserver` plugin factory. `create()` builds a `LitPluginContext`, wraps the host `LanguageService` via `decorate-language-service.ts`, and returns it. The decorator replaces a fixed set of LS methods (`getSemanticDiagnostics`, `getCompletionsAtPosition`, etc.) with delegations to `TsLitPlugin`, which translates between TS LS types and lit-analyzer types and short-circuits to the original method when `config.disable` is set. Config is read from the `ts-lit-plugin` entry in `tsconfig.json` `plugins`, merged with editor-supplied config.

### vscode-lit-plugin packaging

Bundled with esbuild (`esbuild.script.mjs` → `built/bundle.js`) and assembled into `built/` by `copy-to-built.js` before `vsce package`. It registers `ts-lit-plugin` as a `typescriptServerPlugins` entry (see `contributes` in `package.json`) and injects TextMate grammars from `syntaxes/` (vendored from `vscode-lit-html` and `vscode-styled-components`). All user-facing settings (`lit-plugin.*`) are declared in that `package.json`.

## Conventions

- **Import extensions are mandatory.** ESLint enforces `import/extensions: ["error", "always"]` — every relative import must end in `.js` (even though the source is `.ts`). Match the existing style: `import { X } from "./foo.js"`.
- **No `console`.** `no-console` is an error. Use the `LitAnalyzerLogger` (`context.logger`) instead.
- **Formatting is enforced** by Prettier (tabs, see `prettier.config.js`) and checked in CI/`npm test`. A `lint-staged` pre-commit hook runs `eslint --fix` + `prettier`.
- **Never edit `README.md` files directly** — they are generated from `readme.blueprint.md` + `readme.config.json` + `docs/readme/*`. Edit those sources and run `npm run readme`.
- Core TS config (`tsconfig.json` at root): `target: es5`, `module: commonjs`, `strict`, declaration maps on. Each package has a `tsconfig.json` that extends it for `tsc --build` project references.
