---
id: adr-0043-vite-8-3-5-and-angular-compiler-22-2-6
category: adrs
tags: [adr, tooling, dependencies, npm, supply-chain, angular]
aliases: [ADR-043, Supported dependency set — vite 8.3.5 and @angular/compiler 22.2.6]
related: [adr-index, adr-0041-forced-dependency-floors-and-electron-42, adr-0038-drop-macos-support-windows-and-linux-only, tooling-slice, desktop-shell-slice, accepted-debt, documentation-system]
version: 1.0
status: active
---

# ADR-043: The supported dependency set adopts `vite` 8.3.5 and `@angular/compiler` 22.2.6

## Problem

[[adr-0041-forced-dependency-floors-and-electron-42]] made two things exact at the repository root: the four transitive `overrides` (`dompurify` `3.4.17`, `vite` `8.3.3`, `joi` `18.2.9`, `@vitest/mocker` `4.1.12`) and the `@angular/compiler` devDependency, hoisted so the hoisted `@angular/core` could resolve its **exact** peer. Exact pins are only useful while they still describe the supported resolution. Two of them no longer do.

The Angular packages resolve `22.2.6`: `@angular/core` moved with the framework set (`@angular/common`, `@angular/compiler`, `@angular/compiler-cli`, `@angular/forms`) under the workspace's existing carets, and `@angular/core@22.2.6` declares the exact optional peer `"@angular/compiler": "22.2.6"`. The root devDependency was still pinned to `22.2.3`, so the single hoisted root copy could not satisfy the peer the hoisted core declares. In parallel, `@angular/build@22.2.7` declares `"vite": "8.3.5"` as a plain exact dependency, while the root override still forced `vite` to `8.3.3`. The pinned set had become a set of pins that disagree with the graph they pin.

This is a **dependency-set adoption**, not another sweep. The question is only which version tokens the root declares as supported; the floors, the Electron runtime and the provisioning path are not re-opened.

## Solution

Decision, itemized. Both values are exact, as they already were — the change is the value, never the pinning style.

1. **The two adopted tokens.** `package.json` (repository root):

   | token | was (ADR-0041) | adopted | verified in the tree |
   |---|---|---|---|
   | `devDependencies["@angular/compiler"]` | `22.2.3` | **`22.2.6`** | one root copy; `@angular/core` `22.2.6` declares the exact peer `@angular/compiler` `22.2.6` |
   | `overrides.vite` | `8.3.3` | **`8.3.5`** | `vite` resolves `8.3.5` once; `@angular/build` `22.2.7` declares `vite` `8.3.5` exactly |

2. **Everything else in ADR-0041 stands unchanged.** The other three overrides stay `dompurify` `3.4.17`, `joi` `18.2.9` and `@vitest/mocker` `4.1.12`; the shell keeps `electron` exactly `42.11.9`; the root `allowScripts` map keeps `"electron@42.11.9": true`; and the binary is still provisioned by the root `postinstall` → `tools/scripts/provision-electron.js`, not by an Electron install script. None of those tokens is re-decided here.

3. **ADR-0041 is superseded by reference, for those two version tokens only.** ADR-0041 stays `active`, is not edited, and its body remains byte-identical. Its item 2 sentence that names `vite` `8.3.3`, its item 3 Electron text and its Exit criterion that names `@angular/compiler` `22.2.3` all stay as written and **read through this ADR**. No `supersedes` key is declared on either side, following the precedent ADR-0041 set for ADR-0038: the predecessors keep their own text, and the successor is the current answer for exactly the named tokens.

4. **What the tree resolves now, measured rather than assumed.** From the committed lockfile:

   - `@angular/core` `22.2.6` and `@angular/compiler` `22.2.6` — one hoisted copy each, no nested copies under `apps/*` or `libs/*`.
   - `@angular/build` `22.2.7`; its `vite` dependency is `8.3.5`, the same value as the override.
   - `vite` `8.3.5` — one resolved copy, no nested copies.
   - `vitest` `4.1.12` and `@vitest/mocker` `4.1.12`; the mocker override is unchanged.
   - `dompurify` `3.4.17`, `joi` `18.2.9` and `electron` `42.11.9` — unchanged.
   - The workspace manifests were not edited: `apps/angular/package.json` still declares `^22.2.3` for the framework packages and `^22.2.3` for `@angular/build`. The resolved versions moved under those carets; the only exact tokens are the root pins.

5. **npm 12 was re-confirmed while landing the `vite` override — kept as evidence.** Changing `overrides.vite` from `8.3.3` to `8.3.5` and running a plain `npm install` exited successfully and **left `vite` at `8.3.3`**; `npm ls vite` then reported `invalid` with `ELSPROBLEMS`. `npm update vite` applied the override: `vite` resolved `8.3.5` once, with no duplicate copies. This is ADR-0041 item 5's behaviour reproduced, not a new finding: verify an override with `npm ls <pkg>` after changing it, and regenerate with `npm update <pkg>` when the existing tree keeps the old resolution.

### Consequences

- **The exact pins agree with the graph again.** The root compiler equals the exact peer of the hoisted core, and the root `vite` override equals the exact dependency of `@angular/build`. A future divergence is a visible lockfile or `npm ls` diff against a pin rather than a silent re-resolution.
- **ADR-0041 remains the record of the floors.** It keeps its historical numbers; anyone reading it alone sees a two-token set that has been superseded. This ADR is the current answer for the supported compiler and `vite` versions — the other four tokens still read from ADR-0041.
- **Bumping a token is still an explicit act.** Both values are exact, so the next move is a commit with a diff, not an install-time accident.
- **No Electron, packaging or provisioning surface moved.** The `42.11.9` pin, the `allowScripts` key and the root `postinstall` path are untouched by this adoption, so the desktop provisioning contract is exactly as ADR-0041 left it.
- **The Angular ranges remain carets, and that is the residual.** The next framework patch will move `@angular/core` again and the root compiler pin will have to be rechecked against core's exact peer — that is the maintenance cost of hoisting an exact peer, recorded rather than hidden.
- **Not a general upgrade.** No package outside the two tokens changes by this decision, and the four floors of ADR-0041 are not an upgrade strategy.

### Exit criterion

- Done when: the root `package.json` declares `@angular/compiler` `22.2.6` in `devDependencies` and `vite` `8.3.5` in `overrides`; the lockfile resolves `vite` `8.3.5`, `@angular/core` `22.2.6` and `@angular/compiler` `22.2.6` with no nested copies of any of the three; `dompurify` `3.4.17`, `joi` `18.2.9`, `@vitest/mocker` `4.1.12` and `electron` `42.11.9` are unchanged; `npm ls vite @angular/compiler @angular/core` reports one resolved version each with no duplicates; and ADR-0041 is unedited.

## When to use

- When asking what the supported dependency resolution is: this ADR for the two adopted tokens, [[adr-0041-forced-dependency-floors-and-electron-42]] for the remaining floors and the Electron runtime.
- When the exact `@angular/compiler` peer of the hoisted `@angular/core` moves under the existing caret ranges: raise the root devDependency to match and prove it with a clean `npm ci`.
- When `@angular/build`'s own `vite` dependency moves: decide deliberately whether the root override follows it.
- When an override change looks applied because `npm install` exited 0: check `npm ls <pkg>`, then apply with `npm update <pkg>`.

## When not to use

- Not to change the supported platforms or the Electron runtime — those belong to [[adr-0038-drop-macos-support-windows-and-linux-only]] and ADR-0041, unchanged.
- Not to edit ADR-0041. It is append-only; its item 2/3 numbers stay as written and read through this ADR.
- Not as a general dependency sweep: only the two named tokens are adopted here.
- Not to change the Angular ranges in the workspace manifests — this is about the root's exact tokens, not the carets that resolve them.
- Not as a change to the provisioning contract: the `allowScripts` key and `tools/scripts/provision-electron.js` are untouched.

## Examples

```text
root package.json
  "devDependencies": {
    "@angular/compiler": "22.2.6"      // was 22.2.3 — matches @angular/core's exact peer
  },
  "overrides": {
    "@vitest/mocker": "4.1.12",        // unchanged (ADR-0041)
    "dompurify": "3.4.17",             // unchanged (ADR-0041)
    "joi": "18.2.9",                   // unchanged (ADR-0041)
    "vite": "8.3.5"                    // was 8.3.3 — equals @angular/build 22.2.7's exact dep
  },
  "allowScripts": { "electron@42.11.9": true, … }   // unchanged (ADR-0041)

resolved state (committed lockfile)
  @angular/core       22.2.6   -> exact peer @angular/compiler 22.2.6
  @angular/compiler   22.2.6   -> one root copy, no nested copies
  @angular/build      22.2.7   -> dependency "vite": "8.3.5"
  vite                8.3.5    -> one resolved copy, no nested copies
  vitest              4.1.12   | @vitest/mocker 4.1.12 (override unchanged)
  dompurify 3.4.17     | joi 18.2.9 | electron 42.11.9 (unchanged)

npm 12 evidence while landing the vite override
  npm install                    -> exit 0, but vite stayed 8.3.3
  npm ls vite                    -> invalid / ELSPROBLEMS
  npm update vite                -> vite 8.3.5, one resolved copy, no duplicates

supersession shape (no `supersedes` key on either side)
  ADR-0041 item 2 "vite 8.3.3"                  -> reads as 8.3.5
  ADR-0041 Exit criterion "compiler 22.2.3"     -> reads as 22.2.6
  everything else in ADR-0041                   -> unchanged, still authoritative
```

## Common mistakes

- **Editing ADR-0041's item 2, item 3 or Exit criterion to the new numbers.** ADR-0041 is append-only and stays byte-identical; its numbers read through this ADR. Rewriting the predecessor destroys the record of what was decided when.
- **Raising the root `@angular/compiler` without checking core's peer.** `@angular/core` declares the compiler peer exactly; a root copy that does not match is the broken-hoist state ADR-0041 fixed, not an upgrade.
- **Assuming `@angular/core` stayed at `22.2.3`.** It moved to `22.2.6` with the framework set under the existing carets; the compiler pin follows it.
- **Trusting `npm install`'s exit code after changing an override.** It stays green while the tree keeps `vite` `8.3.3`; `npm ls` is the check and `npm update <pkg>` is the apply step.
- **Reading `overrides.vite` as the only source of `vite`'s version.** `@angular/build` declares the same exact dependency today; if the build tool moves and the override does not, the two disagree and the override wins silently.
- **Treating this as a supersession of ADR-0041 as a whole.** Only two version tokens are superseded by reference; the four floors, the Electron pin and the provisioning contract still read from ADR-0041.
- **Counting this as a dependency sweep.** No package outside the two tokens is decided here.

## References

- Predecessor; floors and Electron runtime unchanged, two tokens read through this ADR: [[adr-0041-forced-dependency-floors-and-electron-42]]
- Platform set and Electron runtime lineage: [[adr-0038-drop-macos-support-windows-and-linux-only]]
- Tooling slice (workspace, npm and provisioning scripts): [[tooling-slice]]
- Desktop-shell slice (Electron runtime and packaging): [[desktop-shell-slice]]
- Accepted debt, including the unsigned package: [[accepted-debt]]
- Corpus contract and version-bump rule: [[documentation-system]]
- ADR hub: [[adr-index]]
- Root `overrides`, `allowScripts` and `@angular/compiler` devDependency: [package.json](../../package.json)
- Resolved versions: [package-lock.json](../../package-lock.json)
- Angular workspace manifest, ranges unchanged: [apps/angular/package.json](../../apps/angular/package.json)
- Shell manifest, `electron` pin unchanged: [apps/electron/package.json](../../apps/electron/package.json)
