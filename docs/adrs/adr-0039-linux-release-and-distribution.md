---
id: adr-0039-linux-release-and-distribution
category: adrs
tags: [adr, release, ci, github-actions, distribution, linux, electron]
aliases: [ADR-039, Linux release and distribution]
related: [adr-index, adr-0037-windows-release-and-distribution, adr-0038-drop-macos-support-windows-and-linux-only, repository-configuration, documentation-system, accepted-debt, desktop-shell-slice, tooling-slice]
version: 1.1
status: active
---

# ADR-039: The `v<version>` tag publishes four pinned unsigned assets — two Windows executables and two Linux packages — from two read-only build jobs and one write-scoped publish job

## Problem

[[adr-0037-windows-release-and-distribution]] decided how a Windows build reaches a user and stated, in its clause 1, that the `linux:` and `mac:` blocks of `apps/electron/electron-builder.yml` are *build configurations, not a distribution commitment*. [[adr-0038-drop-macos-support-windows-and-linux-only]] then narrowed the product to Windows and Linux, removed macOS end to end, and recorded that Linux remained a supported platform **without** a published pipeline. Both records were correct when written. Together they left one claim standing that the product had already made elsewhere: `website/index.html` advertises a Linux download next to the Windows one, both buttons resolve to `https://github.com/Nijnamovich/singulari-tree/releases/latest`, and that release carried two `.exe` files only. A Linux visitor followed an advertised path to nothing — precisely the defect ADR-0038 removed for macOS, still open for Linux.

Publishing the configured Linux targets is not a parameter flip. It adds a second runner class, a second output format set, artifact names whose arch token is not the Windows one, packaging metadata the deb target refuses to build without, and a publish job that must receive four files while staying write-scoped. Leaving those implicit is expensive in three specific ways: a build job that runs `npm ci` and `electron-builder` sharing the token that can write to the repository; a deb whose default artifact name escapes into a subdirectory and can never be a flat release asset; and an install layout that inherits the scoped npm name because nobody named the executable. This ADR records the decisions that close all of it, itemizes the pinned names, and separates the shipped result from what remains deliberately deferred.

## Solution

Decision, itemized. The release pipeline is still the single file `.github/workflows/release.yml` — separate from `ci.yml`, its own concurrency group — and it now runs three jobs instead of two.

1. **Two read-only build jobs and one writer.** The job graph is exactly:

   | job id | `runs-on` | `permissions` | role |
   |---|---|---|---|
   | `build-windows` | `windows-latest` | inherits the workflow-level `contents: read` | builds the two Windows executables, uploads artifact `installers-windows-<run_id>` from `apps/electron/release/*.exe` |
   | `build-linux` | `ubuntu-latest` | inherits the workflow-level `contents: read` | builds the AppImage and the deb, uploads artifact `installers-linux-<run_id>` from `apps/electron/release/*.AppImage` and `apps/electron/release/*.deb` |
   | `release` | `ubuntu-latest` | declares `contents: write` — the only writer | downloads both artifacts, asserts all four assets, publishes the release |

   The two build jobs mirror each other step for step — same fail-fast assertion, same Node/Go setup, same build order, same packaging step shape — so the two OSes cannot drift apart silently. `build-linux` passes `--linux` explicitly to `electron-builder` instead of relying on host-based defaults, per ADR-0038's warning that a bare `dist` falls back to the host.

2. **The publish job moved from `windows-latest` to `ubuntu-latest`, and still runs no repository build code.** The move makes the publish step's bash globs native: the previous Windows runner needed a backslash workaround for paths the shell globbed, and that workaround is gone rather than ported. `release` runs **no checkout, no npm, no Go** — only `actions/download-artifact` twice plus the `gh` CLI.

3. **Least privilege is unchanged, not weakened.** The workflow-level `permissions:` stays `contents: read`; neither build job declares a `permissions:` block, so the jobs that run `npm ci`, the bash build scripts and `electron-builder` can never write. Only `release` declares `contents: write`, and the token is exposed to the publish **step** through an environment variable rather than to the job, so the third-party artifact-download steps never see it. The concurrency group is unchanged: `release-${{ github.workflow }}-${{ inputs.tag || github.ref_name }}` with `cancel-in-progress: false` — a tag push and a dispatch for the same tag serialize, and an in-flight release is never cancelled mid-upload. Both artifact names are still keyed on `github.run_id` alone and deliberately exclude `github.run_attempt`, because "Re-run failed jobs" skips the already-successful build job but still increments the attempt; `overwrite: true` is kept so a full re-run replaces the artifact instead of failing on an immutable name. The `release` job keeps its implicit `success()` guard and depends on both build jobs.

4. **Four pinned asset names, and the arch token genuinely diverges.**

   | target | pinned asset name | pinned by |
   |---|---|---|
   | NSIS Setup | `SingulariTree-Setup-<version>-x64.exe` | top-level `nsis.artifactName` (unchanged) |
   | Portable | `SingulariTree-Portable-<version>-x64.exe` | top-level `portable.artifactName` (unchanged) |
   | AppImage | `SingulariTree-AppImage-<version>-x86_64.AppImage` | **new** top-level `appImage.artifactName` |
   | deb | `SingulariTree-deb-<version>-amd64.deb` | **new** top-level `deb.artifactName` |

   The two Windows names are the contract ADR-0037 already pinned and are not touched. The Linux names are new, and their arch token is not a typo: electron-builder maps `x64` to `x86_64` for the AppImage target and to `amd64` for the deb target (`getArtifactArchName` in `builder-util`). Both are pinned literally and asserted literally, in the build job and again in the publish job, so a future electron-builder that changes either mapping fails the release instead of shipping a mislabelled asset.

5. **The deb needed an explicit `artifactName` for a second, mechanical reason.** Its unpinned default was `@singularitree/electron_<version>_amd64.deb`. The npm scope's `/` is treated as a path separator, so the artifact escaped into a `release/@singularitree/` subdirectory and could never appear as a flat release asset — an upload glob rooted at `apps/electron/release/` would miss it, and so would any checksum list. The explicit name is what makes the deb a first-class asset rather than a file in a directory nobody publishes.

6. **Two packaging metadata additions were unavoidable.** Both are minimum changes that make the deb target build at all; neither is a preference.
   - `apps/electron/electron-builder.yml` → `linux.maintainer`. The deb/fpm target aborts with *"It is required to set Linux .deb package maintainer"* when the package declares neither an author nor a maintainer. There is no way to produce the deb without it.
   - `apps/electron/package.json` → `homepage`. `FpmTarget.computePackageUrl()` reads the homepage from package metadata (or from a `repository` field); it is **not** an electron-builder YAML key, so the value had to be added to the package manifest.

7. **`linux.executableName` corrects a scoped-name leak.** Without it the packaging fell back to the npm package name `@singularitree/electron`, which leaked into the Linux install layout: the binary landed at `/opt/SingulariTree/@singularitreeelectron`, the desktop entry was named `@singularitreeelectron.desktop`, and the hicolor icons `@singularitreeelectron.png`. `linux.executableName: singularitree` yields `/opt/SingulariTree/singularitree`, `singularitree.desktop` and `singularitree.png`. This is a packaging-identity fix, not a rename of the product.

8. **The tag/version assertion is unchanged.** Both build jobs assert `TAG == v<apps/electron/package.json version>` **before installing or building anything**, so the version bump must land in `main` before the tag is pushed. A mismatch still fails fast, in both jobs, with no dependency installed.

9. **The publish sequence is unchanged.** `gh release view` → `gh release create --draft --verify-tag` only when the release is absent → `gh release upload --clobber` → `gh release edit --draft=false --prerelease=false`. Every run still ends PUBLISHED, because `website/index.html` resolves against `/releases/latest`, which excludes drafts and prereleases.

10. **The publish job derives the version from the tag, because it has no checkout.** It cannot read `apps/electron/package.json`, so it computes `VERSION="${TAG#v}"` and refuses a tag that does not start with `v`. That derivation is safe only because both build jobs already asserted the tag against the packaged version; the publish job then asserts all four exact filenames exist in `installers/windows` and `installers/linux` **before** touching the Releases API, so a partial asset set never becomes a release.

11. **The artifacts are still UNSIGNED, and on Linux that has its own consequences.** The packaging-contract header of `apps/electron/electron-builder.yml` is unchanged: **UNSIGNED builds only — no signing, notarization or auto-update keys.** The Linux consequence is not softer than the Windows one and is recorded without softening:
    - The `.deb` is not GPG-signed and is not served from a signed apt repository. A user who installs it must trust the downloaded file itself; `dpkg -i` or a graphical installer will install an unverified package, and some environments will warn or refuse unless the user overrides them. There is no chain of trust from a repository key to the package.
    - The `.AppImage` carries no signature of any kind. A user who runs it has no way to verify the publisher beyond the download itself.
    - Nothing notifies a Linux user that a newer release exists. `electron-updater` is not wired, there is no repository to `apt upgrade` from, and no AppImage update information is published, so a user stays on the downloaded version until they fetch another one.
    - This is expected behaviour for the current packaging contract, not a defect to triage per report. Release notes and the landing page must keep stating the unsigned status, and publishing a SHA-256 checksum beside each asset remains the only mitigation available without signing.

12. **Relation to ADR-0037 and ADR-0038: refinement by reference, not supersession.** Both predecessors stay `active` and are **not edited**; this ADR declares no `supersedes:`, exactly as ADR-0038 refined ADR-0037. What changes is read through this record:
    - ADR-0037 clause 1 ("Windows-only release scope", "no pipeline publishes them") is superseded **by reference for its Linux half only**. Its macOS half was already narrowed by ADR-0038, and its statement that the `linux:` targets remain *build configurations* is now the pre-image of a published pipeline.
    - ADR-0037 refers to "the `build` job". After this decision that phrase reads as **the two read-only build jobs**, `build-windows` and `build-linux`. Its least-privilege clause — write scope confined to a job that runs no repository build code — is **preserved, not weakened**: the writer is still a single job with no checkout, no npm and no Go, and it now receives four files instead of two.
    - ADR-0037 also names the artifact transport: its clause 6 and its Examples block state that the build job uploads `windows-installers-<run_id>` and that the publish job downloads it into `installers/`. The shipped pipeline uploads `installers-windows-<run_id>` and unpacks it into `installers/windows/`, beside the sibling `installers-linux-<run_id>` → `installers/linux/`, so neither OS can overwrite the other's files. ADR-0037's text is **not** edited (append-only): the authoritative names are this ADR's clause-1 table and `.github/workflows/release.yml` itself.
    - ADR-0038's consequence "Linux also has no published pipeline" and its "When not to use" bullet refusing a Linux distribution decision are both discharged here: this **is** that decision. Its exit criterion that the two pinned `.exe` assets are still published unchanged continues to hold.
    - ADR-0037's open debt is unchanged by this record. **Signing, notarization, signed flatpak/AppImage and auto-update remain deferred** to the V1.4 phase, and actions are still referenced by mutable version tags rather than pinned to a commit SHA. Publishing Linux assets does not reduce either item; it adds a second unsigned format to the same deferral.

**What this record does not prove.** The Windows artifacts cannot be produced on a Linux host, so the Windows legs are verified by the pipeline definition and by the unchanged packaging contract, not by a local build. The AppImage was produced by a local packaging run but **not executed**: the packaging environment has no FUSE and no display, so only the file's existence and format were verified — not that it launches, and not that its desktop entry renders. The first real `v<version>` tag remains the only proof that both runners build and that the four assets publish together. Until then, the assertions in the workflow are a constraint on what may be published, not evidence that it was.

**One separate change in the same commit is not part of this decision.** The root `package.json` `allowScripts` map gained `"esbuild@0.28.2": true` (keeping `electron@41.10.6` and `esbuild@0.28.1`), because npm blocks unlisted install scripts: the nested `esbuild@0.28.2` copies under `apps/angular` and `libs/ui-kit` never ran their postinstall and stayed 9 KB `#!/usr/bin/env node` shims instead of native ELF binaries, so the renderer build silently ran unoptimized. That is a lockfile-policy/tooling fix with no bearing on which platforms are published, and it is recorded here only so the two changes are not mistaken for one.

### Consequences

- **One tag, one release, four files, two operating systems.** A user has one download path and, inside it, exactly four choices with pinned names: two Windows executables and two Linux packages. There is no second mirror that can drift.
- **The landing page stops advertising an asset that did not exist.** The Linux download button now resolves to a real package. Nothing in `website/index.html` needed to change — the claim it already made is now true.
- **A partial release is impossible by construction.** Both build jobs must succeed before `release` runs, and the publish step asserts all four filenames before the Releases API is touched. A failed assertion leaves no release and no partial asset set.
- **The write scope still covers nothing that executes repository code.** Two build jobs, one writer: `build-windows` and `build-linux` are read-only, and the publishing job only downloads artifacts and calls `gh`. A compromised build dependency in either OS cannot use the release token.
- **Recorded honestly: Linux users download unsigned packages.** No `.deb` signature, no repository key, no AppImage signature, no update notification. Package-manager tooling may warn or refuse, and support must describe that as the expected state rather than a fault.
- **Build cost doubles.** Every release now pays for two full builds — `npm ci`, the Go core, the renderer and `electron-builder` — on two runner classes. That is the price of a published Linux asset, not an inefficiency to be optimized away by cross-building Windows from Linux, which the toolchain does not support here.
- **The two build jobs can drift.** They are deliberately duplicated rather than shared, so a build step added to one and not the other produces an OS-specific failure. The mirroring comment in the workflow is the contract; it is not enforced by any check.
- **A failed tag is still permanent on the remote.** The version/tag assertion is unchanged, and so is its consequence: the operator must delete and re-create the tag after landing a corrected bump.
- **The deferred debt got wider, not smaller.** Signing and auto-update now cover four assets across two OSes instead of two assets on one. Nothing in this decision schedules that work.

### Exit criterion

- Done when: pushing a `v<version>` tag whose `version` matches `apps/electron/package.json` produces a **published** GitHub Release (not a draft, not a prerelease) carrying exactly `SingulariTree-Setup-<version>-x64.exe`, `SingulariTree-Portable-<version>-x64.exe`, `SingulariTree-AppImage-<version>-x86_64.AppImage` and `SingulariTree-deb-<version>-amd64.deb`; `build-windows` and `build-linux` both run with the inherited `contents: read`, the `release` job runs no checkout, npm or Go step, and only `release` declares `contents: write`; a tag that does not match the packaged version fails in both build jobs before any install; and the landing-page CTA at `https://github.com/Nijnamovich/singulari-tree/releases/latest` resolves to that release.

## When to use

- When cutting a release: bump `apps/electron/package.json`, land it in `main`, then tag `v<version>` — for both OSes at once, not one at a time.
- When editing `.github/workflows/release.yml`: confirm a change to one build job is mirrored in the other, and that no build step appears in `release`.
- When editing `apps/electron/electron-builder.yml`: confirm the four `artifactName` blocks and `linux.executableName` still produce the asserted names.
- When a Linux user reports an unsigned-package warning, an installer refusal or a package-manager complaint: the unsigned status is the expected behaviour, not a regression.
- When a Linux user reports a broken install layout (`@singularitreeelectron`, a missing desktop entry): start from `linux.executableName`.
- When planning signing, a signed apt repository, flatpak or auto-update: this ADR records the four unsigned assets those decisions must cover.

## When not to use

- Not as a signing design, an apt-repository design or an auto-update design: all of it remains deferred (V1.4) and none of it is specified here.
- Not as a re-litigation of the Windows pipeline: tag coupling, the published-release rule, the job split and the two `.exe` names belong to [[adr-0037-windows-release-and-distribution]] and are unchanged.
- Not as a platform-support decision: macOS stays dropped and Linux stays supported per [[adr-0038-drop-macos-support-windows-and-linux-only]].
- Not as proof of the GitHub UI settings: the Layer 2 checklist in [[repository-configuration]] is human-only and, as of this decision, deferred debt ([[accepted-debt]]).
- Not for the corpus contract, frontmatter or generated indexes — see [[documentation-system]].
- Not as a CI test plan: build and test behaviour belongs to `ci.yml`, not to the release pipeline.

## Examples

```text
1. bump the version and land it in main BEFORE tagging
   apps/electron/package.json   "version": "1.2.3"

2. tag that commit
   git tag v1.2.3 && git push origin v1.2.3

3. release.yml  (on: push tags v*  ->  two build jobs, then publish)

   build-windows  (runs-on: windows-latest; permissions inherited: contents: read)
     assert  TAG == v${VERSION}            -> abort before any install
     npm ci; build-go-core.sh; renderer build; npm run dist
     assert  apps/electron/release/SingulariTree-Setup-1.2.3-x64.exe
     assert  apps/electron/release/SingulariTree-Portable-1.2.3-x64.exe
     upload  installers-windows-<run_id>   (only *.exe)

   build-linux    (runs-on: ubuntu-latest; permissions inherited: contents: read)
     assert  TAG == v${VERSION}            -> the same assertion, before any install
     npm ci; build-go-core.sh; renderer build; npm run dist -- --linux
     assert  apps/electron/release/SingulariTree-AppImage-1.2.3-x86_64.AppImage
     assert  apps/electron/release/SingulariTree-deb-1.2.3-amd64.deb
     upload  installers-linux-<run_id>     (only *.AppImage and *.deb)

   release        (runs-on: ubuntu-latest; needs: [build-windows, build-linux];
                   permissions: contents: write; no checkout, no npm, no Go)
     download installers-windows-<run_id> -> installers/windows
     download installers-linux-<run_id>   -> installers/linux
     VERSION="${TAG#v}"                    -> no checkout, so the tag is the source
     assert all four exact filenames       -> before the Releases API is touched
     gh release create v1.2.3 --draft --verify-tag     (only when absent)
     gh release upload v1.2.3 \
        installers/windows/*.exe installers/linux/*.AppImage installers/linux/*.deb \
        --clobber
     gh release edit   v1.2.3 --draft=false --prerelease=false

4. the published release carries exactly
     SingulariTree-Setup-1.2.3-x64.exe
     SingulariTree-Portable-1.2.3-x64.exe
     SingulariTree-AppImage-1.2.3-x86_64.AppImage
     SingulariTree-deb-1.2.3-amd64.deb

Arch token rule:  x64 on Windows; x86_64 for AppImage; amd64 for deb.
                  pinned in electron-builder.yml, asserted in both jobs.
Tag rule:         TAG == "v" + version in apps/electron/package.json.

Re-publish an existing tag:  workflow_dispatch with the tag input
                  (same assertions; all four assets are overwritten, never duplicated).
```

## Common mistakes

- **Granting `contents: write` at workflow level "so the release job can publish four files"** — that hands the scope to both build jobs, which run `npm ci` and repository scripts.
- **Adding a packaging or build step to `release`** — the write-scoped job must stay free of repository build code; new build steps belong in a build job, and in both of them.
- **Changing one build job and not the other** — the two are mirrored on purpose; a step added only to `build-linux` is an OS-specific failure waiting for the next tag.
- **"Fixing" the `x86_64` / `amd64` divergence** — the tokens come from electron-builder's per-target arch mapping and are asserted literally; normalizing them breaks the assertion, not the bug.
- **Renaming the deb to the scoped default** (`@singularitree/electron_<version>_amd64.deb`) — the `/` becomes a path separator and the artifact escapes into `release/@singularitree/`, where no flat upload glob finds it.
- **Dropping `linux.maintainer` or the `homepage` field "since the build worked locally"** — the deb target aborts without a maintainer, and fpm reads the homepage from package metadata, not from the builder YAML.
- **Removing `linux.executableName`** — the scoped npm name leaks back into `/opt`, the desktop entry and the icon names.
- **Adding `github.run_attempt` to an artifact name** — "Re-run failed jobs" skips the successful build job but bumps the attempt, so the publish job looks for an artifact that was never uploaded under that name.
- **Announcing a quiet Linux install** — the deb is unsigned and not served from a signed repository; package tooling may warn or refuse, and support must say so.
- **Assuming the publish job can read `apps/electron/package.json`** — it has no checkout; the tag is the only version source there, and it is trusted solely because both build jobs asserted it.
- **Assuming the landing page needs a change for Linux** — it already advertises both platforms; the pipeline is what had to catch up.
- **Treating this as a supersession of ADR-0037 or ADR-0038** — both stay `active` and unedited; only their Linux-unpublished clauses are narrowed, by reference.

## References

- Release pipeline, refined by this record: [[adr-0037-windows-release-and-distribution]]
- Platform set (Windows and Linux only) and the dropped macOS surface: [[adr-0038-drop-macos-support-windows-and-linux-only]]
- Permission audit, the human-only settings and the unsigned-installer consequences: [[repository-configuration]]
- Accepted debt, including the UNSIGNED package and the deferred UI settings: [[accepted-debt]]
- Shell slice (packaging and install layout): [[desktop-shell-slice]]
- Tooling slice (build scripts and CI): [[tooling-slice]]
- Corpus contract and version-bump rule: [[documentation-system]]
- ADR hub: [[adr-index]]
- The shipped workflow: [release.yml](../../.github/workflows/release.yml)
- Packaging contract and the four pinned asset names: [electron-builder.yml](../../apps/electron/electron-builder.yml)
- Landing-page download entries, already advertising both platforms: [website/index.html](../../website/index.html)
