---
id: adr-025-deep-links-and-clipboard-clone
category: adrs
tags: [adr, desktop-shell, deep-link, clipboard, m3]
aliases: [ADR-025, Deep links and clipboard clone]
related: [adr-index, feature-gap-analysis, desktop-shell-slice, renderer-slice, core-slice]
version: 1.0
status: active
---

# ADR-025: Deep links (OS protocol handler) + clipboard clone URL

## Problem

There is no OS URL-scheme registration, no deep-link routing into the app, and no clipboard-based clone affordance. M3 should let a `singularitree://…` link (or a git URL copied to the clipboard) open the app and route to a repo, commit or branch, and prefill the future clone dialog. A decision is needed on where the scheme is registered, where the link is parsed and validated, and how it reaches the renderer without moving Git out of the core.

Slices: desktop-shell primary; renderer and core secondary.

## Solution

Decision, itemized.

1. **Register a custom scheme — provisional `singularitree://`.** Electron main calls `app.setAsDefaultProtocolClient('singularitree')` behind a **single-instance lock**, and handles macOS `open-url` plus Windows/Linux argv / `second-instance`. The scheme name is recorded as a **reversible default**: it may be renamed before shipping, and app registration is cheap to change.
2. **Routing stays in the shell.** The shell parses and validates the deep link and forwards a **normalized IPC event `deeplink:open`** to the renderer. The renderer routes it to existing per-repo IPC calls (e.g. `OpenRepository`, `Checkout`). **The shell never runs Git** and the renderer never talks to Git.
3. **URL grammar (documented):**
   - `singularitree://open?path=<abs>` — open a repo by absolute path.
   - `singularitree://open/<repo>/commit/<oid>` — open a repo at a commit.
   - `singularitree://open/<repo>/branch/<name>` — open a repo at a branch.
   - `singularitree://clone?url=<git-url>` — prefill only; clone itself is V1.4 onboarding.
4. **Clipboard clone.** The renderer reads a git URL from the clipboard (user-initiated), validates that it is a plausible git remote URL, and prefills the future (V1.4) clone dialog; a "copy repo URL to clipboard" affordance is also in scope. No Git is contacted in the renderer.
5. **Layering.** The deep link introduces a **shell↔renderer IPC channel** (and shell argv parsing), **not** a proto change. If a proto field is ever needed, it is appended per ADR-003.

### Security

- Validate the scheme/host; reject unknown forms.
- A `path` argument must be absolute and is validated by the core's existing `OpenRepository` guard.
- Never execute a user shell from a deep link or pasted clipboard content.

## Consequences

- The scheme registration is provisional and reversible; renaming it later touches only the shell.
- Deep links reuse existing per-repo RPCs; no Git logic enters the shell.
- `deeplink:open` is a new typed IPC channel, consistent with the desktop-shell slice.

## When to use

- When the OS hands the app a `singularitree://` URL.
- When prefilling clone from a clipboard git URL.

## When not to use

- Not to run Git in the shell or renderer to satisfy a deep link.
- Not to treat the scheme name as frozen: it is a reversible default.
- Not to add a proto field for routing unless a real payload requires it (append per ADR-003).

## Examples

```text
singularitree://open?path=/home/me/projects/app
singularitree://open/app/commit/a1b2c3d
singularitree://open/app/branch/main
singularitree://clone?url=https://example.com/me/app.git    // prefill only (V1.4)
```

```text
os -> scheme -> electron main (single-instance lock)
   -> parse + validate -> ipc event 'deeplink:open'
   -> renderer -> existing per-repo IPC (OpenRepository / Checkout)
```

## Common mistakes

- **Registering the scheme per window** instead of behind a single-instance lock.
- **Parsing and routing the link in the renderer** and running Git there.
- **Treating the provisional scheme name as permanent.**
- **Executing a shell command** from a deep link or clipboard value.

## References

- Desktop shell slice: [desktop-shell-slice](../slices/desktop-shell-slice.md)
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- Core slice: [core-slice](../slices/core-slice.md)
- Feature-gap analysis: [[feature-gap-analysis]]
- ADR hub: [[adr-index]]
