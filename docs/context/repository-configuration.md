---
last_updated: 2026-10-21
status: active
description: Repository-level GitHub configuration for SingulariTree — a verified audit of the three workflows' permissions and the release pipeline's job graph, the settings that only a human can apply, the initial hardening recommendations, and the end-user consequences of shipping unsigned installers on Windows and Linux.
tags:
- ci
- github-actions
- release
- permissions
- security
version: 1.1.0
related:
- documentation-system
---

# Repository Configuration

## Problem

The repository is the only durable record of how a change reaches a user, but only half of that record lives inside it. `.github/workflows/*.yml` is versioned and reviewable; the workflow-token default, branch protection, tag rules, environments and Pages enablement are clicks in the GitHub UI that no `git clone` carries. Without an explicit split between "verified in the repository" and "must be verified in the UI", least privilege is assumed rather than proven, and the release path — the only job allowed to write — sits one unreviewed edit away from over-permission. The same blind spot hides a product consequence: the published binaries are unsigned, so for many users the first contact with the product is a SmartScreen warning on Windows, and on Linux an install from an unverifiable package.

## Solution

Three layers, in this order: what the files actually declare (auditable from a checkout), what only a human can see or change (GitHub UI), and what to change next.

### Layer 1 — workflow permissions audit (verified from the repository)

One row per workflow; every value below was read from the YAML at the paths in the first column.

| Workflow | Triggers | Workflow-level `permissions:` | Per-job `permissions:` | Concurrency group | Secrets used |
|---|---|---|---|---|---|
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | `push` to `main`, `pull_request`, `workflow_dispatch` | `contents: read` | none — both matrix legs inherit the workflow scope | `ci-${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true` | none |
| [`.github/workflows/pages.yml`](../../.github/workflows/pages.yml) | `push` to `main` filtered by `paths: ['website/**', '.github/workflows/pages.yml']`, `workflow_dispatch` | `{}` — empty, so no scope is granted by default | job `deploy`: `contents: read`, `pages: write`, `id-token: write` | `pages` with `cancel-in-progress: false` | none |
| [`.github/workflows/release.yml`](../../.github/workflows/release.yml) | `push` on tags `v*`, `workflow_dispatch` with optional `tag` input | `contents: read` | jobs `build-windows` (`windows-latest`) and `build-linux` (`ubuntu-latest`) declare none and inherit `contents: read`; job `release` (`ubuntu-latest`) declares `contents: write` and is the only writer | `release-${{ github.workflow }}-${{ inputs.tag || github.ref_name }}` with `cancel-in-progress: false` | none — it authenticates with the implicit workflow token exposed to `gh` through an environment variable |

The split that matters is in `release.yml`: the two build jobs — `build-windows` and `build-linux` — declare no `permissions:` of their own, so neither can ever write, and the `release` job is the only writer. That job runs **no repository build code** — no checkout, no npm or Go step — only the two `actions/download-artifact` steps plus the `gh` CLI. Its write scope therefore covers nothing that executes repository code, and the token is exposed to the publish step rather than to the job, so the third-party download steps never see it.

### Layer 2 — settings that are not readable from the repository (human action)

Nothing in the table below can be derived from a checkout. Each row is a **verify in the GitHub UI** item, not a statement of fact; treat an unverified row as unknown, never as secure.

| # | Area | What to verify in the GitHub UI | Why it matters |
|---|---|---|---|
| 1 | Default workflow token permission | Settings → Actions → General → Workflow permissions: read-only vs. read/write. The repository declares explicit scopes in all three workflows, but the repository-wide default that applies to any future workflow is invisible from the files. | An implicit read/write default silently upgrades every new workflow. |
| 2 | Branch protection / rulesets on `main` | Required pull request, required reviews, required status checks, force-push block, linear history, who may bypass. The check names this repository actually produces are `CI / ubuntu-latest` and `CI / windows-latest` (the `ci.yml` matrix job is named `${{ matrix.os }}`). | Required checks only work when the exact names are selected. |
| 3 | Tag protection / rulesets | Who may create `v*` tags, and whether releases may be created by anyone with write access. | A tag push is what triggers the publishing job. |
| 4 | Secrets and variables | Repository-, environment- and organization-scoped secrets, their rotation, and who can read them. Today no workflow references a stored secret. | The moment a secret is added, its scope becomes the real access boundary. |
| 5 | Environments | `github-pages` (declared in `pages.yml`) and its protection rules; whether to add a dedicated `release` environment with required reviewers. | An environment is the only place to insert human approval before a job. |
| 6 | Pages configuration | The Pages source must be set to "GitHub Actions" once. `pages.yml` deliberately leaves `enablement` unset because enabling Pages needs a non-`GITHUB_TOKEN` actor, so it is left to the human. | Without it the deploy job uploads an artifact nobody serves. |
| 7 | Actions policy | "Allow GitHub Actions to create and approve pull requests", approval rules for first-time contributors and fork pull requests, restricting Actions to this repository, and any allow-list of actions. | Fork pull requests run untrusted code in the CI job. |
| 8 | Security features | Secret scanning, push protection, dependency graph, Dependabot (including the `github-actions` ecosystem), and the immutability policy for releases (GitHub's immutable releases setting, which blocks modifying a published release or its tag). | Dependabot is the only practical tracker for pinned action versions. |
| 9 | Release access and retention | Whether releases may be created by users with read access, and release-asset retention. | Release creation is a publish action even when it does not touch `main`. |

### Layer 3 — initial repository-configuration recommendations

Each item states the change, the rationale, and where it is configured.

1. **Set the default workflow token permission to read-only** ("Read repository contents and packages permissions"). All three workflows already declare least privilege, so a read-only default is a safe backstop for any future workflow. *Where:* Settings → Actions → General → Workflow permissions.
2. **Protect `main`** with a branch protection rule or a ruleset: require a pull request, at least one review, the status checks `CI / ubuntu-latest` and `CI / windows-latest`, block force pushes and deletions, and restrict bypass to administrators instead of everyone. *Where:* Settings → Branches / Rulesets.
3. **Restrict release-tag creation** with a ruleset for `v*` tags so only maintainers can push them. The tag must be `v<version>` and match `apps/electron/package.json`'s `version`; the release workflow refuses to publish when they diverge, so the version bump must land **before** the tag is pushed. *Where:* Settings → Rules → Tags.
4. **Keep `contents: write` confined to the publishing job.** The workflow already does this — neither build job can write. The rule is to preserve that split when adding steps: a new step that needs checkout or a build belongs in a build job, never in `release`, and a step added to one build job must be mirrored in the other.
5. **Pin third-party actions to a full commit SHA.** Today the repository uses mutable version tags: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-go@v5`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5` and `actions/deploy-pages@v5`. A moved tag silently changes what runs with the workflow token. *Where:* the three workflow files, plus Dependabot for the `github-actions` ecosystem to keep the pins current.
6. **Add a `release` GitHub Environment with required reviewers**, restricted to the `v*` tag pattern, and point the publishing job at it. That puts human approval in front of the only write-scoped job. *Where:* Settings → Environments.
7. **Add a `CODEOWNERS` file** covering `.github/workflows/` and `apps/electron/electron-builder.yml` so a change to the release path always requests a release owner's review. *Where:* `.github/CODEOWNERS`.
8. **Enable secret scanning, push protection and Dependabot**, including the `github-actions` ecosystem so workflow action versions are tracked. *Where:* Settings → Code security.
9. **Restrict Actions to this repository** and require approval for outside contributors' pull requests before the CI job runs untrusted code. *Where:* Settings → Actions → General → Fork pull request workflows.
10. **Keep the Pages source on "GitHub Actions"** and do not grant the Pages deployment job anything beyond `contents: read`, `pages: write` and `id-token: write` — the current state of `pages.yml`. *Where:* Settings → Pages plus the job block itself.
11. **Document the release procedure**: bump `apps/electron/package.json`'s version, push the `v<version>` tag, let the Release workflow build on `windows-latest` and `ubuntu-latest` and attach all four unsigned assets — the NSIS installer, the portable executable, the AppImage and the deb package. The landing-page button points at the latest release, so the release must be **published** — not a draft, not a prerelease — for the download link to resolve.

### The unsigned installer — what end users actually see

The packaging contract at [`apps/electron/electron-builder.yml`](../../apps/electron/electron-builder.yml) states in its header that the builds are **UNSIGNED**: no signing, no notarization, no auto-update. The user-visible consequences are concrete and must not be softened in release notes:

- Windows SmartScreen shows the "Windows protected your PC" warning, because the binaries carry no Authenticode signature and no download reputation.
- The end user must choose **More info**, then **Run anyway**. There is no quieter path.
- The warning may not appear at all for some users, so the download experience is **inconsistent** and support cannot assume it happened.
- Managed or corporate machines (SmartScreen policies, AppLocker, antivirus heuristics) can block the installer outright, with no user-level override.
- Silent and unattended installation is unreliable on managed machines, and it cannot be presented as a trusted-publisher (UAC) prompt because the binary is unsigned — the NSIS target's `/S` switch exists, but without a signature an unattended run is not trustworthy.
- Every fresh download re-triggers the warning until the binary gains reputation or is signed.

On Linux the same unsigned status has its own consequences, recorded with the same honesty:

- The `.deb` is not GPG-signed and is not served from a signed apt repository. Installing it means trusting the downloaded file itself (`dpkg -i` or a graphical installer), and package tooling may warn or refuse the package unless the user overrides it. There is no repository key vouching for the artifact.
- The `.AppImage` carries no signature of any kind, so a user has no way to verify the publisher beyond the download itself.
- Nothing notifies a Linux user that a newer release exists: `electron-updater` is not wired, and there is no apt repository to upgrade from. A user stays on the downloaded version until they fetch another one.
- This is the expected behaviour of the current packaging contract, not a defect to triage per report.

Mitigations to apply now, without signing: publish the SHA-256 checksum of each asset in the release notes, state the unsigned status on the download page (the landing page already does), and keep the version pinned so users can match the artifact to the notes. Long term — and explicitly **out of scope now** — code signing with an OV/EV certificate or Azure Trusted Signing removes the Windows warning; on Linux the equivalent is a GPG-signed package served from a signed repository plus a signed AppImage (or a flatpak); signing, notarization and auto-update are deferred (see [[accepted-debt]]).

### Release asset naming

Four assets are published, and all four names are pinned in `apps/electron/electron-builder.yml`:

| Target | Asset | Pinned by |
|---|---|---|
| NSIS Setup | `SingulariTree-Setup-<version>-x64.exe` | top-level `nsis.artifactName` |
| Portable | `SingulariTree-Portable-<version>-x64.exe` | top-level `portable.artifactName` |
| AppImage | `SingulariTree-AppImage-<version>-x86_64.AppImage` | top-level `appImage.artifactName` |
| deb | `SingulariTree-deb-<version>-amd64.deb` | top-level `deb.artifactName` |

The names are fixed rather than defaulted because electron-builder's defaults contain spaces (which become `%20` in the download URL) and would collide visually in the release asset list, in download dialogs and in shell commands. The arch token is **not** uniform and is not a typo: electron-builder maps `x64` to `x86_64` for the AppImage target and to `amd64` for the deb target (`getArtifactArchName`), and the workflow asserts both literally.

The deb needed an explicit `artifactName` for a second reason. Its default was `@singularitree/electron_<version>_amd64.deb`: the npm scope's `/` is treated as a path separator, so the package escaped into a `release/@singularitree/` subdirectory and could never appear as a flat release asset. The explicit name is what makes it publishable at all. The publish job asserts all four exact filenames before it touches the Releases API, so a misnamed or missing package fails the release instead of producing a partial asset set.

## When to use

- Before editing a workflow, `electron-builder.yml` or any release-path file: re-read the audit table and confirm the edit does not widen a scope.
- When reviewing a release, or diagnosing "the workflow did not run" / "the release failed": distinguish repository-declared behavior from UI-side configuration.
- When a user reports a SmartScreen warning or a blocked installer, or a Linux package manager refusing the `.deb`.
- When onboarding a maintainer who needs to know which settings live outside `git`.

## When not to use

- It cannot grant, prove or fix a permission: a document is not a substitute for the GitHub settings themselves; verify them in the UI.
- Not for local build, test or docs commands — those live in the Commands table of [docs/project.md](../project.md).
- Not for the corpus contract, frontmatter or generated indexes — see [documentation-system.md](./documentation-system.md).
- Not a signing design: code signing, notarization and auto-update are deferred by decision, not documented here as a plan.

## Examples

Adding a step to the publishing job while keeping the split:

```yaml
jobs:
  build-windows:
    # no permissions: block — inherits the workflow-level `contents: read`
    ...
  build-linux:
    # same: inherits `contents: read`, and mirrors build-windows step for step
    ...
  release:
    needs: [build-windows, build-linux]
    permissions:
      contents: write     # the only writer; no checkout, no build step
```

Release sequence — the version bump always lands before the tag:

```bash
# 1. bump "version" in apps/electron/package.json and commit it to main
# 2. tag the merge commit with the same v<version>
git tag v1.2.3 && git push origin v1.2.3
# 3. the Release workflow builds, verifies version == tag, publishes assets
```

Auditing a workflow diff: read the workflow-level `permissions:`, then every job-level block, then every `uses:` line. A new `uses:` with a mutable tag is a review blocker under recommendation 5.

## Common mistakes

- Granting `contents: write` at workflow level "so the release job can write" — it hands the same scope to every job in the file, including the one that runs `npm ci` and repository scripts.
- Leaving actions on mutable version tags and treating Dependabot as a substitute for pinning: a tag that moves between runs changes code that executes with the workflow token.
- Pushing the `v*` tag before the version bump lands; the release workflow rejects the mismatch, and the failed tag stays on the remote.
- Expecting the release created with the implicit workflow token to trigger other workflows: events caused by that token do not start new runs, so post-release automation needs a separate mechanism.
- Assuming `pages.yml` enables Pages. It leaves `enablement` unset on purpose; the source must be set to "GitHub Actions" once by a human.
- Publishing a draft or a prerelease and then wondering why the landing-page download button 404s — the button resolves against the latest published release.
- Reading the Layer 1 audit as proof of the Layer 2 settings. The YAML says what a workflow asks for; only the UI shows what it is allowed to do.

## References

- Project entry point and Commands: [docs/project.md](../project.md)
- Corpus contract and version-bump rule: [documentation-system.md](./documentation-system.md)
- Accepted debt, including the UNSIGNED package decision: [accepted-debt.md](./accepted-debt.md)
- Workflows audited above: [ci.yml](../../.github/workflows/ci.yml), [pages.yml](../../.github/workflows/pages.yml), [release.yml](../../.github/workflows/release.yml)
- Packaging contract: [apps/electron/electron-builder.yml](../../apps/electron/electron-builder.yml)
