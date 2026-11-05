---
id: adr-0037-windows-release-and-distribution
category: adrs
tags: [adr, release, ci, github-actions, distribution, windows, electron]
aliases: [ADR-037, Windows release and distribution]
related: [adr-index, repository-configuration, accepted-debt, documentation-system, tooling-slice]
version: 1.0
status: active
---

# ADR-037: Windows releases are unsigned GitHub Releases produced from a `v<version>` tag by a single least-privilege pipeline that publishes exactly two pinned executables

## Problem

The repository could build installers long before it could ship one. `apps/electron/electron-builder.yml` declares three platform blocks — `win` (`nsis`, `portable`), `linux` (`AppImage`, `deb`) and `mac` (`dmg`, `zip`) — but a build configuration is not a distribution decision. Nothing turned a tag into a download, nothing named the files a user should pick, and nothing recorded the consequences of shipping binaries that are unsigned. Meanwhile `website/index.html` already pointed its download buttons at `https://github.com/Nijnamovich/singulari-tree/releases/latest`, so the end-user contract existed only as an `href`: any release shape that path ignores (a draft, a prerelease, a differently named asset) silently breaks the only download the product advertises.

Three failure modes were left implicit and each is expensive to discover late: a tag that does not match the packaged version publishes mislabelled artifacts; the job that can write to the repository is also the job that runs `npm ci` and repository scripts, widening the blast radius of a compromised dependency; and an unsigned installer meets SmartScreen on the user's machine, which support must be able to explain without improvising. This ADR records the shipped pipeline, itemizes what it deliberately is, and separates that from what it deliberately is **not** yet.

## Solution

Decision, itemized. The release pipeline is the single file `.github/workflows/release.yml`, triggered by a `v*` tag push or by `workflow_dispatch` with an optional `tag` input. It is separate from `ci.yml` (its own file, its own concurrency group) so a release never cancels CI and CI never cancels a release.

1. **Windows-only release scope.** The pipeline runs on `windows-latest` and publishes only the two Windows executables. The `linux:` (`AppImage`, `deb`) and `mac:` (`dmg`, `zip`) targets remain in `apps/electron/electron-builder.yml`, but no pipeline publishes them: they are build configurations, not a distribution commitment. Publishing a Linux or macOS artifact is a new decision, not a parameter of this one.
2. **The artifacts are unsigned.** The two Windows targets are NSIS Setup and Portable. The packaging-contract header of `apps/electron/electron-builder.yml` states it plainly: **UNSIGNED builds only — no signing, notarization or auto-update keys.** So the decision is to ship unsigned binaries, not to pretend otherwise. The end-user consequence is concrete and is recorded without softening: Windows SmartScreen shows the "Windows protected your PC" warning because the executables carry no Authenticode signature and no download reputation; the user must choose **More info**, then **Run anyway**. The warning is inconsistent — it may not appear at all for some users, so support cannot assume it happened — and on managed or corporate machines SmartScreen policies, AppLocker or antivirus heuristics can block the installer outright, with no user-level override. Release notes and the landing page must keep stating the unsigned status; it is not a defect to be triaged per report.
3. **GitHub Releases is the only distribution channel.** There is no store listing, no self-hosted mirror, no vendor CDN. The repository's Releases page is the product's download surface, and every asset a user downloads comes from a release created by this workflow.
4. **The release must be PUBLISHED — never a draft, never a prerelease.** `website/index.html` points its download buttons at `https://github.com/Nijnamovich/singulari-tree/releases/latest`, and `/releases/latest` excludes drafts and prereleases. The publish step is therefore idempotent and always ends in a published state: `gh release create "$TAG" --draft --verify-tag` only when the release is absent, `gh release upload "$TAG" installers/*.exe --clobber` to overwrite same-named assets on a re-run, and finally `gh release edit "$TAG" --draft=false --prerelease=false` — the last line also clears a prerelease flag a previous manual edit may have set, so the landing-page CTA always resolves.
5. **The tag `v<version>` is coupled to `apps/electron/package.json`.** The build job asserts `TAG == v${VERSION}` **before installing or building anything** and fails otherwise, so the version bump must land in `main` **before** the tag is pushed. Two further assertions guard the artifacts: the build job checks that `apps/electron/release/SingulariTree-Setup-<version>-x64.exe` and `apps/electron/release/SingulariTree-Portable-<version>-x64.exe` exist before uploading, and the publish step checks that both assets are present in `installers/` **before** touching the Releases API. A version bump that never reaches `main` cannot be released by accident.
6. **Least privilege, enforced by the job split.** The workflow-level `permissions:` is `contents: read`. The `build` job declares no `permissions:` of its own and inherits it, so the job that runs `npm ci`, the bash build scripts and `electron-builder` can never write. Only the `release` job declares `contents: write`, and it runs **no repository build code**: no checkout, no npm, no Go — only `actions/download-artifact` plus the `gh` CLI. The write token is scoped to the publish step's environment, not to the job, so the third-party download step never sees it. The concurrency group is `release-${{ github.workflow }}-${{ inputs.tag || github.ref_name }}` with `cancel-in-progress: false`: a tag push and a dispatch for the same tag serialize, and an in-flight release is never cancelled mid-upload. The artifact name `windows-installers-${{ github.run_id }}` deliberately excludes `run_attempt`, so "Re-run failed jobs" (which skips the successful `build` job but increments the attempt) still finds the uploaded artifact; `overwrite: true` makes a full re-run replace it instead of failing on an immutable name.
7. **Asset names are pinned.** `SingulariTree-Setup-<version>-x64.exe` (NSIS) and `SingulariTree-Portable-<version>-x64.exe` (portable), fixed by the top-level `nsis:` and `portable:` `artifactName` blocks in `apps/electron/electron-builder.yml`. electron-builder's defaults contain spaces and would appear as `%20` in the download URL; `win.nsis` / `win.portable` are not valid schema keys. The names are a contract: the build job asserts them and release notes, checksums and support instructions refer to them.

### Open debt

Two items are deliberately **not** part of the decision above. They are debt, recorded here so they are not mistaken for settled design, and they are explicitly out of scope for this change.

- **Actions are referenced by mutable version tags, not pinned to a full commit SHA** — `actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-go@v5`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`. This is **recommendation 5** in `docs/context/repository-configuration.md` (line 62) and it is **not implemented**: a tag that moves between runs silently changes what executes with the workflow token, and the release job's token can write. Reduction path: pin every `uses:` to a full SHA and let Dependabot (the `github-actions` ecosystem) keep those pins current. Until then, adding a new `uses:` on a mutable tag is a review blocker.
- **Signing, notarization and auto-update remain deferred** — the accepted-debt row in `docs/context/accepted-debt.md` (line 32). The reduction is scheduled at the **V1.4** phase: macOS notarization, Windows signing, signed flatpak/AppImage and auto-update. This ADR does not design any of it; it only records that the current pipeline ships unsigned binaries with no update mechanism, and that this is a known, dated deferral rather than an oversight.

The **human-only follow-ups are not part of this pipeline.** The GitHub UI settings — the default workflow token permission, branch protection on `main`, `v*` tag rulesets, a `release` environment with required reviewers, `CODEOWNERS`, secret scanning/Dependabot and the Pages source — live in `docs/context/repository-configuration.md` and are **not readable from a checkout**. The workflow can be reviewed and still be over-permitted in practice; only the UI shows what it is allowed to do. The first real release is the proof that the pipeline works, and it is also the only proof that those settings are correct.

### Consequences

- **One channel, one OS, two files.** A user has exactly one download path and exactly two choices inside it. There is no ambiguity about which artifact is current, and no second mirror that can drift.
- **Recorded honestly: the first contact with the product may be a security warning.** Unsigned binaries trigger SmartScreen's "Windows protected your PC"; the user must go through **More info → Run anyway**, and on managed machines the installer may be blocked with no override. The experience is inconsistent across machines, so support guidance must describe the warning without promising it will appear.
- **Recorded honestly: there is no auto-update.** A user on an older release stays on it until they download again. Nothing in the pipeline notifies them, and `electron-updater` is deferred to V1.4 with signing.
- **A mislabelled release is caught before it exists.** Three assertions stand between a tag and the Releases API: tag equals version, both installers exist after packaging, both assets exist after download. A failed assertion leaves no release and no partial asset set.
- **The write scope covers nothing that executes repository code.** `build` is read-only and the publishing job only downloads artifacts and calls `gh`; a compromised build dependency cannot use the release token.
- **A failed tag is permanent on the remote.** The workflow rejects a version/tag mismatch, but the tag has already been pushed; the operator must delete and re-create it after landing the bump. The safe order is enforced by the pipeline, not by memory.
- **Draft and prerelease states are corrected by the pipeline, not trusted.** Every run ends with `--draft=false --prerelease=false`, so `/releases/latest` resolves even after a manual edit — but only for releases the pipeline publishes.
- **The mutable-tag debt is real, not cosmetic.** Until recommendation 5 is implemented, the code that runs with the write-capable token is whatever the referenced tags point at on that day.
- **Multi-OS publishing is not implied.** `linux:` and `mac:` remain build targets; adding them to the release is a new ADR-level decision with its own signing and packaging consequences.
- **Recorded honestly: the landing page's Linux and macOS buttons resolve to a Windows-only release.** Every download button in `website/index.html` points at `/releases/latest`, so a Linux or macOS visitor currently finds only the two `.exe` assets there; the page already labels those builds preliminary, and per-OS availability is part of the future multi-OS decision, not of this pipeline.

### Exit criterion

- Done when: pushing a `v<version>` tag whose `version` matches `apps/electron/package.json` produces a **published** GitHub Release (not a draft, not a prerelease) carrying exactly `SingulariTree-Setup-<version>-x64.exe` and `SingulariTree-Portable-<version>-x64.exe`; the `build` job runs read-only and the `release` job runs no checkout, npm or Go step; a tag that does not match the packaged version fails before any install or build; and the landing-page CTA at `https://github.com/Nijnamovich/singulari-tree/releases/latest` resolves to that release.

## When to use

- When cutting a Windows release: bump `apps/electron/package.json`, land it in `main`, then tag `v<version>`.
- When editing `.github/workflows/release.yml` or `apps/electron/electron-builder.yml`: confirm the edit does not widen a scope or break an assertion.
- When a user reports a SmartScreen warning or a blocked installer: the unsigned status is the expected behaviour, not a regression.
- When the landing-page download button 404s: check whether the release is published and whether the asset names still match.
- When planning signing, notarization or auto-update: start from the debt rows here and supersede or extend this ADR.

## When not to use

- Not as a signing design: signing, notarization and auto-update are deferred (V1.4) and are not specified here.
- Not as a plan for a store listing or a multi-OS publishing channel: those are separate decisions with their own artifacts.
- Not for the corpus contract, frontmatter or generated indexes — see [[documentation-system]].
- Not as proof of the GitHub UI settings: the permission audit and the human-only checklist live in [[repository-configuration]] and cannot be verified from a checkout.
- Not as a CI test plan: build and test behaviour belongs to `ci.yml`, not to the release pipeline.

## Examples

```text
1. bump the version and land it in main BEFORE tagging
   apps/electron/package.json   "version": "1.2.3"
   git commit -am "release: 1.2.3" && git push origin main

2. tag the commit that contains the bump
   git tag v1.2.3
   git push origin v1.2.3

3. release.yml (on: push tags v*  ->  windows-latest)

   build job  (permissions inherited: contents: read)
     assert  TAG == v${VERSION}        -> abort when the bump is not in main
     npm ci
     ./tools/scripts/build-go-core.sh
     npm run build --workspace=@singularitree/angular
     npm run dist --workspace=@singularitree/electron
     assert  apps/electron/release/SingulariTree-Setup-1.2.3-x64.exe
     assert  apps/electron/release/SingulariTree-Portable-1.2.3-x64.exe
     upload  windows-installers-<run_id>   (only *.exe)

   release job  (needs: build; permissions: contents: write; no checkout, no build)
     download windows-installers-<run_id> -> installers/
     assert   installers/*Setup-*.exe and installers/*Portable-*.exe
     gh release create v1.2.3 --draft --verify-tag    (only when absent)
     gh release upload v1.2.3 installers/*.exe --clobber
     gh release edit   v1.2.3 --draft=false --prerelease=false

4. the landing-page CTA
   https://github.com/Nijnamovich/singulari-tree/releases/latest
   now resolves to v1.2.3

Tag rule:  TAG  ==  "v" + version in apps/electron/package.json
           any other tag fails before a single dependency is installed.

Re-publish an existing tag:  workflow_dispatch with the tag input
           (same assertions; assets are overwritten, never duplicated).
```

## Common mistakes

- **Pushing the tag before the version bump lands** — the workflow rejects the mismatch, and the failed tag stays on the remote until someone deletes it.
- **Publishing a draft or a prerelease and wondering why the landing-page CTA 404s** — `/releases/latest` excludes both; only a published release resolves.
- **Granting `contents: write` at workflow level "so the release job can write"** — that hands the scope to the `build` job, which runs `npm ci` and repository scripts.
- **Assuming `pages.yml` enables Pages** — it leaves `enablement` unset on purpose; the source must be set to "GitHub Actions" once by a human.
- **Treating the repository's permission audit as proof of the UI-side settings** — the YAML says what a workflow asks for; only the GitHub UI shows what it is allowed to do.
- **Leaving actions on movable tags and calling Dependabot a substitute for pinning** — Dependabot keeps pins current; it does not create them. Until every `uses:` carries a full SHA, a moved tag changes what runs with the write-capable token.
- **Renaming the assets or the `nsis:` / `portable:` blocks** — the build job asserts the exact names, and release notes, checksums and support instructions refer to them.
- **Adding a build step to the `release` job** — the write-scoped job must stay free of repository build code; new build steps belong in `build`.
- **Announcing a quieter install experience** — the binaries are unsigned; SmartScreen may warn, may not, and managed machines may block the installer outright.
- **Assuming the landing-page Linux or macOS button delivers a matching asset** — the pipeline publishes Windows executables only; `/releases/latest` currently serves the two `.exe` files, and per-OS publishing is a new ADR-level decision.

## References

- Repository configuration: the permission audit, the UI-only settings and the unsigned-installer consequences: [[repository-configuration]]
- Accepted debt, including the UNSIGNED package row: [[accepted-debt]]
- Corpus contract and generated indexes: [[documentation-system]]
- Tooling slice (CI, build scripts, validations): [[tooling-slice]]
- ADR hub: [[adr-index]]
- The shipped workflow: [release.yml](../../.github/workflows/release.yml)
- Packaging contract and pinned asset names: [electron-builder.yml](../../apps/electron/electron-builder.yml)
- Landing-page CTA that resolves against `/releases/latest`: [website/index.html](../../website/index.html)
