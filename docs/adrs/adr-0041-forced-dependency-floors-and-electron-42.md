---
id: adr-0041-forced-dependency-floors-and-electron-42
category: adrs
tags: [adr, tooling, dependencies, npm, electron, supply-chain]
aliases: [ADR-041, Forced dependency floors and Electron 42]
related: [adr-index, adr-0038-drop-macos-support-windows-and-linux-only, adr-0037-windows-release-and-distribution, adr-0039-linux-release-and-distribution, accepted-debt, tooling-slice, desktop-shell-slice]
version: 1.0
status: active
---

# ADR-041: Four transitive dependencies are forced to exact floors from the root, and the Electron runtime moves to 42.11.9

## Problem

Two dependency questions and one reproducibility fix landed together, and all of them are about **pinning or placement**, not about features.

**Transitive floors.** Four packages had to be raised across the workspace: `dompurify` `>= 3.4.17`, `vite` `>= 8.3.3`, `joi` `>= 18.2.9` and `@vitest/mocker` `>= 4.1.12`. None of them is a direct dependency of the apps; they arrive through Angular, vitest and the tooling graph, so there is no manifest entry to edit directly — the lever is npm `overrides` in the **root** `package.json`. A range in `overrides` is not a floor, though: it re-resolves against registry-latest at install time, which is how `vite` would jump to 8.3.5 and `@vitest/mocker` to 5.x in the same tree. `@vitest/mocker` 5.x is **incompatible with vitest 4.1.11**, so a "satisfies the requested `>=`" range is capable of installing a tree that does not run.

**Electron 42.** The shell was pinned to `41.10.6`, and [[adr-0038-drop-macos-support-windows-and-linux-only]] item 4 recorded that exact version as the **supported shell runtime** for the two remaining platforms. The supported runtime is now `42.11.9`, a major bump. A major Electron bump re-opens the packaging contract and the provisioning contract (`tools/scripts/provision-electron.js`) at the same time, and the pin lives in three places that must move in lockstep: the workspace manifest, the root `allowScripts` map and the provisioner's own version example. The `allowScripts` entry is **policy, not mechanism**: `electron@42.11.9` ships no install script (its lockfile entry carries no `hasInstallScript`), so the binary is provisioned by the root `postinstall` → `tools/scripts/provision-electron.js`, independent of npm allowlisting.

## Solution

Decision, itemized. Every pin below is **exact** (`"8.3.3"`), never a range and never a caret.

1. **Root npm `overrides`, exact.** `package.json` (repository root) declares:

   | override | pinned | why this one |
   |---|---|---|
   | `dompurify` | `3.4.17` | the requested floor; no newer resolution is wanted |
   | `vite` | `8.3.3` | stays on the `8.3.x` patch line that `@angular/build` 22.2.3 depends on (`vite: "8.3.0"` is a plain dependency, with no peer range to widen) while satisfying `>= 8.3.3` |
   | `joi` | `18.2.9` | the requested floor |
   | `@vitest/mocker` | `4.1.12` | the newest line compatible with vitest 4.1.11; 5.x breaks it |

2. **Exact, not `>=`, because a range defeats the purpose.** npm `overrides` accept a range and re-resolve it on every install; with `>=` the tree silently drifts (`vite` → 8.3.5, `@vitest/mocker` → 5.x) and the install is no longer reproducible. Exact pins satisfy the requested `>=` floors, keep the lockfile honest and make a future bump a deliberate commit rather than an install-time accident.

3. **Electron `42.11.9`, pinned exactly, in three places.** `apps/electron/package.json` carries `"electron": "42.11.9"` (direct devDependency, exact); the root `allowScripts` map carries the matching key `"electron@42.11.9": true` as a **belt-and-braces policy entry**, not as the provisioning mechanism — `electron@42.11.9` declares no install script, so the binary comes from the root `postinstall` → `tools/scripts/provision-electron.js`; the key is kept in lockstep so a future Electron release that *does* ship an install script is not silently blocked; and `tools/scripts/provision-electron.js` uses `42.11.9` in its error example so the message points at the supported pin. **No shell source changes were needed**: the main/preload/IPC code compiled and the suite passed unchanged on the new major.

4. **Provisioning stays idempotent.** The provisioner is a cache-then-download step keyed by version and platform; re-running it against `42.11.9` is a no-op once the binary is present. `42.11.9` is provisioned in this environment, so `npm start` does not re-download it.

5. **npm 12.0.2 silently ignores new overrides while an old tree exists.** A plain `npm install` did **not** apply the new workspace overrides when the previous `node_modules` tree was already present — it exited successfully and left the old resolution in place. The tree was regenerated with `npm update vite dompurify joi @vitest/mocker`; that is the documented workaround, not a routine step. Verify an override with `npm ls <pkg>` after changing it, never by trusting the exit code of `npm install`.

6. **Transitive consequences are limited and recorded.** The only moves below the four floors are nested `rolldown@1.2.15` (plus its platform bindings) under `vite`, and a nested `@vitest/spy@4.1.12` under `@vitest/mocker`. Nothing else in the tree changed shape **as a result of the overrides**, and `npm ls` reports no duplicate copies of the five pinned packages (the four overrides plus Electron). The separate compiler dedupe is recorded below.

7. **Relation to ADR-0038: item 4 superseded by reference, the platform decision untouched.** [[adr-0038-drop-macos-support-windows-and-linux-only]] stays `active` and is **not edited**. Its item 4 — "Electron 41.10.6 is the supported shell runtime" — is superseded **by reference**: the supported runtime is `42.11.9`. Everything else in that ADR stands, in particular the **Windows and Linux only** product decision, the removal of the macOS packaging block, shell paths and landing-page entry, and the explicit statement that the Go core keeps its darwin build paths. Consequently [[adr-0037-windows-release-and-distribution]] and [[adr-0039-linux-release-and-distribution]] are unchanged: the same two read-only build jobs, the same four pinned unsigned assets, the same publish job. ADR-0038's exit criterion that a Windows and a Linux build succeed **on the supported Electron** now reads as `42.11.9`.

### Reproducibility fix: the root `@angular/compiler` hoist

Landed in the same change set, but **not a version upgrade** — a placement fix. `@angular/core@22.2.3` is hoisted to the repository root and declares an **exact** peer, `"@angular/compiler": "22.2.3"`, while `@angular/compiler` had been resolved as two nested copies (`apps/angular/node_modules/@angular/compiler`, `libs/ui-kit/node_modules/@angular/compiler`). A clean install could therefore not run the Angular suite — `Cannot find package '@angular/compiler' imported from node_modules/@angular/core/fesm2022/testing.mjs` — because the hoisted core resolved its peer from the root, where no copy existed. CI on `main` had been red for the same reason since the Angular update.

The fix is one root `devDependencies` entry, `"@angular/compiler": "22.2.3"`: npm hoists a single root copy and dedupes the nested ones. The lockfile diff is exactly that — one `node_modules/@angular/compiler@22.2.3` entry added, the two nested copies removed, nothing else. **Proof is a clean `npm ci` from the committed lockfile**, not a warm `node_modules`; the verification evidence below was measured on that clean tree.

| state | root copy | nested copies | clean-install suite |
|---|---|---|---|
| before | — | `apps/angular`, `libs/ui-kit` | fails (peer not found from the hoisted `@angular/core`) |
| after | `22.2.3` | none | 85 files / 1326 tests pass |

### Consequences

- **The tree is reproducible and the floors are real.** Every install from the committed lockfile resolves the same four versions, a clean `npm ci` reproduces the full suite, and a future registry-latest release cannot drag `@vitest/mocker` into an incompatible major or `vite` off the `8.3.x` line behind a green `npm install`.
- **Bumping a pin is now an explicit act.** A caret or range would have absorbed the change; an exact pin means the next upgrade is a commit with a diff, reviewed like any other.
- **The overrides live in the root only.** In an npm-workspaces tree, a workspace manifest's `overrides` are ignored; the root is the single place these floors can be declared, and duplicating them per workspace would be a no-op that looks like configuration.
- **Electron 42 is the supported runtime for both shipped platforms.** Windows and Linux build and ship on `42.11.9`; the Windows/Linux-only decision, the unsigned packaging contract and the release pipeline are unchanged.
- **The provisioning contract moved with the pin.** The provisioner is what fetches the binary; the `allowScripts` key is the matching policy entry (belt-and-braces, for any release that ships an install script), and the version example is the operator-facing message. Version, `allowScripts` and the example are moved as one unit, so a bump that forgets the example points at a stale runtime and one that forgets the manifest pin would ship an older binary — the lockstep is what makes either mistake visible in review.
- **No shell source change was required, and that is recorded rather than assumed.** The major bump was validated by the existing Electron typecheck and test suite, not by a compatibility patch.
- **Residual work is deferred, not hidden.** The pins are floors, not an upgrade strategy: when upstreams release versions that are compatible and wanted, a subsequent change revisits the exact set deliberately. Until then the four overrides are the supported resolution.
- **Verification evidence, measured after a clean `npm ci` from the committed lockfile:** Angular `85` test files / `1326` tests passing with coverage `94.80%` statements / `88.51%` branches / `89.43%` functions / `96.71%` lines; the production renderer build succeeds (`Initial total 559.10 kB`, lazy `monaco.css` `390.83 kB`); Electron `12` test files / `148` tests passing plus its typecheck; re-running `tools/scripts/provision-electron.js` is a no-op; and `npm ls` shows the five pinned packages resolved once each, with no duplicates.

### Exit criterion

- Done when: the root `package.json` declares the four exact `overrides` (`dompurify` `3.4.17`, `vite` `8.3.3`, `joi` `18.2.9`, `@vitest/mocker` `4.1.12`); `apps/electron/package.json` pins `electron` `42.11.9`; the root `allowScripts` map carries `electron@42.11.9`; `tools/scripts/provision-electron.js` names `42.11.9`; the root `devDependencies` declares `@angular/compiler` `22.2.3` so a clean `npm ci` resolves a single hoisted copy; `npm ls` reports each pin once with no duplicates; the renderer suite, the production build and the Electron typecheck plus suite pass on the clean install; and no shell source file changed.

## When to use

- When a transitive dependency must be raised above what the current graph resolves and there is no direct manifest entry to edit: declare it in the root `overrides`, exactly.
- When preparing an Electron major bump: move the manifest pin, the `allowScripts` key and the provisioner example together, then re-run typecheck and the suite before touching packaging.
- When an `npm install` appears to ignore a new override: confirm with `npm ls`, then regenerate the tree (`npm update <pkgs>`); do not hand-edit the lockfile.
- When checking what "supported runtime" means for the desktop product: this ADR plus [[adr-0038-drop-macos-support-windows-and-linux-only]] for the platform set.
- When a hoisted package declares an exact peer that resolves to no root copy because the peer sits in nested workspace trees: declare the peer at the root so npm hoists one copy, then prove it with a clean `npm ci`.

## When not to use

- Not to change the supported platforms. Windows and Linux only is ADR-0038's decision and is untouched here.
- Not to change the release pipeline, artifact names or signing status — those belong to [[adr-0037-windows-release-and-distribution]] and [[adr-0039-linux-release-and-distribution]].
- Not as a licence to use ranges in `overrides`: the point of this record is that a range re-resolves and drifts.
- Not to add per-workspace `overrides`: npm ignores them in a workspace; the root is the only effective location.
- Not to "upgrade everything while we are here" — the four floors and the Electron major are the decision, not a general dependency sweep.
- Not as a version bump for `@angular/compiler`: the root pin matches `@angular/core` exactly and only fixes where the peer is resolved; changing the compiler version is an Angular upgrade, reviewed separately.

## Examples

```text
root package.json
  "overrides": {                       // exact, not ">=x" and not "^x"
    "@vitest/mocker": "4.1.12",
    "dompurify": "3.4.17",
    "joi": "18.2.9",
    "vite": "8.3.3"
  },
  "allowScripts": { "electron@42.11.9": true, … }
                                       // policy entry; provisioning is the root postinstall,
                                       // not an Electron install script (42.11.9 has none)

apps/electron/package.json
  "electron": "42.11.9"                // exact devDependency

tools/scripts/provision-electron.js
  Pin it (for example "42.11.9")       // the message names the supported pin

npm 12.0.2 workaround
  npm install                          // silently keeps the old tree when overrides are new
  npm update vite dompurify joi @vitest/mocker
  npm ls vite dompurify joi @vitest/mocker electron
    -> one resolved version each, no duplicates

reproducibility (root devDependency, not a version bump)
  @angular/core 22.2.3 (hoisted)       -> exact peer @angular/compiler 22.2.3
  nested compiler copies under apps/angular + libs/ui-kit -> deduped by the root entry
  proof: clean npm ci -> Angular 85/1326, build, Electron 148, provision no-op

transitive consequences
  vite 8.3.3        -> nested rolldown@1.2.15 (+ bindings)
  @vitest/mocker    -> nested @vitest/spy@4.1.12
```

## Common mistakes

- **Writing `">= 8.3.3"` in `overrides`.** It satisfies the letter of the request and re-resolves at install time; `vite` drifts to 8.3.5 and `@vitest/mocker` to 5.x, which vitest 4.1.11 cannot use.
- **Bumping Electron in `apps/electron/package.json` only.** The provisioner example and the `allowScripts` key are left at the old version; provisioning still succeeds today — the binary comes from the root `postinstall`, not from an Electron install script — but the policy map and the operator-facing message now disagree with the pin.
- **Forgetting the provisioner's version example.** The error message then points at a runtime that is no longer supported, which is exactly the wrong help.
- **Trusting a clean exit from `npm install` after adding overrides.** npm 12.0.2 keeps the existing tree; verify with `npm ls` and regenerate with `npm update <pkgs>`.
- **Hand-editing `package-lock.json` to "force" a version.** The lockfile is generated; an override plus a regenerated tree is the supported path.
- **Fixing a broken peer resolution with a nested install.** `npm i @angular/compiler --workspace=<ws>` recreates the nested copy the hoisted `@angular/core` cannot see; declare the peer at the root so npm hoists one copy, and prove it with a clean `npm ci`.
- **Assuming ADR-0038 is superseded as a whole.** Only item 4 (the Electron 41 pin) is; the Windows/Linux-only decision, the macOS removal and the Go core's darwin paths all stand.
- **Treating the nested `rolldown` / `@vitest/spy` moves as unexplained churn** — they are the visible consequence of the exact-floor decision and are recorded here.

## References

- Supported platforms, unchanged (item 4 superseded here): [[adr-0038-drop-macos-support-windows-and-linux-only]]
- Windows release pipeline, unchanged: [[adr-0037-windows-release-and-distribution]]
- Linux release pipeline, unchanged: [[adr-0039-linux-release-and-distribution]]
- Tooling slice (build, provisioning and CI scripts): [[tooling-slice]]
- Desktop-shell slice (Electron runtime and packaging): [[desktop-shell-slice]]
- Accepted debt, including the unsigned package: [[accepted-debt]]
- ADR hub: [[adr-index]]
- Root overrides, `allowScripts` and the `@angular/compiler` devDependency: [package.json](../../package.json)
- Shell manifest: [apps/electron/package.json](../../apps/electron/package.json)
- Electron provisioner: [provision-electron.js](../../tools/scripts/provision-electron.js)
