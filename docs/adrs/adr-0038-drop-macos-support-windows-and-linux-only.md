---
id: adr-0038-drop-macos-support-windows-and-linux-only
category: adrs
tags: [adr, electron, packaging, platforms, distribution, release]
aliases: [ADR-038, Drop macOS support — Windows and Linux only]
related: [adr-index, adr-0037-windows-release-and-distribution, repository-configuration, accepted-debt, documentation-system, desktop-shell-slice, tooling-slice]
version: 1.1
status: active
---

# ADR-038: The desktop product ships for Windows and Linux only — macOS support is dropped

## Problem

The product advertised three platforms and supported one. [[adr-0037-windows-release-and-distribution]] decided how a Windows build reaches a user — one tag, one published release, two unsigned pinned executables — but it deliberately left the other two platform blocks in `apps/electron/electron-builder.yml` as *build configurations, not a distribution commitment*. Nothing was ever decided about macOS beyond that: the `mac:` block declared `dmg` and `zip`, the shell carried macOS-only code paths (`open-url` deep links, the `activate` handler, the `window-all-closed` exemption), and `website/index.html` rendered a macOS download button — while no pipeline, no release and no asset list ever produced a macOS artifact. A visitor on macOS followed an advertised download path and found only `.exe` files. That is not a gap to document; it is a claim the product does not honour.

The Electron major bump from `32.3.3` to `41.10.6` forced the question at the right moment: a major runtime upgrade re-opens the packaging contract and the provisioning contract (`tools/scripts/provision-electron.js`) at the same time, and a platform whose packaging and provisioning are only carried "just in case" is exactly the kind of surface a major bump should not be asked to keep alive. Supporting three platforms means maintaining three packaging blocks, three code paths, three sets of release consequences and three provisioning entries. Two of them are real product surface; the third was never shipped.

## Solution

Decision, itemized. This ADR records a **narrowing**, not a new pipeline: `macOS` leaves the product's supported-platform set, and nothing else about distribution changes.

1. **Supported platforms: Windows and Linux.** The `mac:` block is removed from `apps/electron/electron-builder.yml`; the `macOS` download entry is removed from `website/index.html`; the macOS-only code paths are removed from the shell (`open-url` deep-link handling, the `activate` handler, the `window-all-closed` exemption) and from `tools/scripts/provision-electron.js`; the `README.md` no longer claims macOS support. The Windows artifact names stay pinned exactly as `SingulariTree-Setup-${version}-${arch}.exe` and `SingulariTree-Portable-${version}-${arch}.exe`, so `.github/workflows/release.yml` is untouched by this decision — the pipeline keeps asserting the same names it always asserted.
2. **What is explicitly NOT dropped.** The Go core keeps its **darwin build paths and its darwin transport behaviour**. `apps/go-core` build tags are untouched; the core still compiles and runs on macOS, and its unix-socket transport is still the darwin path. What is dropped is the **product**: no packaging, no shell, no download, no support claim. Recording this matters because "no macOS" read carelessly becomes "the core cannot build on macOS", which is false and would invite a bogus portability fix.
3. **Relation to ADR-0037: refinement by reference, not supersession.** [[adr-0037-windows-release-and-distribution]] stays `active` and is **not edited** — this ADR does not declare `supersedes:` on it, exactly as [[adr-0035-commit-details-redesign-and-inline-hunk-actions]] refines [[adr-0033-commit-details-files-expandable-panel]] without superseding it. ADR-0037's release-pipeline decision — one tag, one published release, two unsigned Windows executables, least privilege through the `build`/`release` job split, pinned asset names — is **unchanged and still in force**. Exactly one clause is superseded **by reference**: ADR-0037 clause 1 states that "the `linux:` and `mac:` targets remain in `apps/electron/electron-builder.yml`". The `linux:` half still holds; the `mac:` block is gone. ADR-0037's open-debt bullet that lists "macOS notarization" in the V1.4 reduction is narrowed the same way — read it as Windows signing, signed flatpak/AppImage and auto-update only. This ADR is the successor for the **platform-support question only**.
4. **Electron 41.10.6 is the supported shell runtime** for the two remaining platforms. Windows and Linux both build and ship on that major.
5. **The GitHub UI settings stay deferred.** The Layer 2 items in [[repository-configuration]] are **not applied** by this change. They are recorded as accepted debt in [[accepted-debt]] — registered so they are not mistaken for settled configuration, and deliberately not counted as done.

### Consequences

- **macOS users are not served.** Someone on macOS has no installer, no package and no supported path to run the desktop app. The landing page no longer offers a button that resolves to nothing, which is more honest than the previous state, but it is still a platform the product does not reach. The Go core remains usable headlessly there, and that is a developer capability, not product support.
- **Removing the `mac:` block does not by itself forbid a macOS host from producing `dmg`/`zip`.** electron-builder falls back to host-based defaults, so a host that simply runs the packaging script can still emit a macOS target — the packaging configuration is not what makes macOS unsupported. In practice this is moot for the shell: on a macOS host the desktop toolchain cannot even be installed, because `tools/scripts/provision-electron.js` refuses a macOS binary (`getPlatformPath()` throws for `darwin`/`mas`), so the root `postinstall` — and therefore `npm ci` — fails unless `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set. macOS is not a supported development host for the shell; the Go core still builds and runs there. A non-Windows host that packages for Windows must ask for the Windows targets explicitly (`electron-builder --win`). The release pipeline is unaffected: it runs on `windows-latest`, where the host default and the intended target coincide.
- **The `open-url` deep-link path is gone.** On macOS the OS delivered the URL through an Apple Event; without macOS there is no such event. Deep links now arrive as argv on first launch and through the `second-instance` event afterwards — the Windows/Linux mechanism, which was already implemented and is now the only one. The `singularitree://` scheme, the single-instance lock and the normalized `deeplink:open` IPC event are unchanged.
- **The Go core is unaffected.** Domain, services, repository and adapters keep their darwin build tags and darwin transport behaviour. No Go file changes shape because of this decision, and nothing in `apps/go-core` should be "cleaned up" on the grounds that macOS is unsupported.
- **Linux also has no published pipeline.** This ADR makes Linux a *supported platform* in the packaging sense — `AppImage` and `deb` remain configured build targets — but publishing a Linux artifact is still the new decision ADR-0037 said it would be. Nothing here publishes one.
- **Recorded honestly: the platform set is now smaller than the codebase.** The shell and the website no longer carry macOS; the Go core still does. Any future macOS product decision starts from the core's portability and re-adds packaging, shell paths and a landing-page entry — it does not start from zero.

### Exit criterion

- Done when: `apps/electron/electron-builder.yml` contains no `mac:` block, the shell contains no `open-url` / `activate` / `window-all-closed`-exemption code path, `website/index.html` lists no macOS download entry, `README.md` claims no macOS support, a Windows and a Linux build both succeed on Electron `41.10.6`, `apps/go-core` still compiles with its darwin build tags, and `.github/workflows/release.yml` still publishes the two pinned `SingulariTree-Setup-<version>-x64.exe` / `SingulariTree-Portable-<version>-x64.exe` assets unchanged.

## When to use

- When editing `apps/electron/electron-builder.yml`, the shell's window/lifecycle code, `website/index.html` or the README: confirm the edit does not reintroduce a macOS claim or a macOS-only code path.
- When packaging locally on **Linux**: invoke the Windows targets explicitly (`electron-builder --win`) instead of relying on host-based defaults.
- When a macOS user asks for a build: the answer is "not supported"; the Go core is headless-capable on macOS, the desktop product is not.
- When planning to re-add macOS: this ADR is the baseline to supersede, and the packaging, shell paths and landing-page entry all come back together.

## When not to use

- Not as a change to the release pipeline: tag/version coupling, the published-release rule, the job split, least privilege and the pinned asset names all belong to [[adr-0037-windows-release-and-distribution]] and are untouched.
- Not as evidence that the Go core is macOS-incapable — the opposite is explicitly recorded above.
- Not as a Linux distribution decision: `AppImage` and `deb` are configured build targets, not published artifacts.
- Not as proof of the GitHub UI settings: the Layer 2 checklist in [[repository-configuration]] is human-only and, as of this decision, deferred debt ([[accepted-debt]]).
- Not for the corpus contract, frontmatter or generated indexes — see [[documentation-system]].

## Examples

```text
1. packaging — apps/electron/electron-builder.yml
   win:    nsis + portable, artifactName SingulariTree-Setup-${version}-${arch}.exe
                                  artifactName SingulariTree-Portable-${version}-${arch}.exe
   linux:  AppImage + deb
   mac:    (removed — no dmg, no zip, no build target)

2. shell — apps/electron/src/main/main.ts
   removed:  app.on('open-url')            (macOS Apple Event delivery)
             app.on('activate')            (macOS dock re-activation)
             window-all-closed exemption   (macOS keeps the app alive)
   kept:     single-instance lock
             argv scan on first launch        -> deeplink:open
             second-instance argv scan        -> deeplink:open

3. packaging from a Linux host
   npm run dist --workspace=@singularitree/electron -- --win
   (a bare dist on Linux may still fall back to host-based defaults; a macOS host is not a
    supported host for the shell — the provisioner refuses a macOS binary, so `npm ci` there
    needs ELECTRON_SKIP_BINARY_DOWNLOAD=1, while the Go core still builds on macOS)

4. unchanged by this decision
   .github/workflows/release.yml   windows-latest, v<version>, two pinned .exe assets

5. core — apps/go-core
   build tags and the darwin unix-socket transport stay as they are
```

## Common mistakes

- **Treating this as a supersession of ADR-0037** — ADR-0037 stays `active` and unedited; only its clause-1 sentence about the `mac:` target is narrowed, by reference. Do not go back and rewrite the predecessor.
- **Deleting the darwin build paths from `apps/go-core` "since macOS is unsupported"** — the core keeps them; the product dropped macOS, not the core's portability.
- **Assuming the `mac:` block's removal blocks macOS output entirely** — electron-builder's host-based defaults can still emit `dmg`/`zip` on a macOS host; ask for `--win` explicitly.
- **Re-adding a macOS download button before there is a pipeline, a packaging block and shell paths behind it** — that is exactly the state this ADR corrects.
- **Reading "Linux is supported" as "Linux is published"** — `AppImage` and `deb` are configured targets; publishing them is still a separate decision.
- **Counting the deferred GitHub UI settings as applied** — they are registered debt in [[accepted-debt]], not configuration.

## References

- Release pipeline, unchanged: [[adr-0037-windows-release-and-distribution]]
- Refinement without supersession, same shape: [[adr-0035-commit-details-redesign-and-inline-hunk-actions]]
- Deep links, now argv / `second-instance` only: [[adr-025-deep-links-and-clipboard-clone]]
- Shell slice (window lifecycle, deep links, packaging): [[desktop-shell-slice]]
- Core slice (darwin build paths and transport): [[core-slice]]
- Tooling slice (build and provisioning scripts): [[tooling-slice]]
- Repository configuration — Layer 2 human-only settings and the release audit: [[repository-configuration]]
- Accepted debt, including the deferred UI settings and the UNSIGNED package: [[accepted-debt]]
- Corpus contract and version-bump rule: [[documentation-system]]
- ADR hub: [[adr-index]]
- Packaging contract: [electron-builder.yml](../../apps/electron/electron-builder.yml)
- Landing page download entries: [website/index.html](../../website/index.html)
