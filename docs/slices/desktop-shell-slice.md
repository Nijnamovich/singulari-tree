---
id: desktop-shell-slice
category: slices
tags:
- slice
- generality
aliases:
- Desktop Shell slice
related:
- slices-index
version: 1.3.0
status: active
---

# Desktop Shell — Slice Generalities

## What this slice is

Electron shell that hosts the desktop application: main process, preload, typed IPC, Go core supervisor, window, menu and CSP policy.

## Boundaries

- **IN:** `apps/electron/**`.
- **OUT:** Go core, Angular renderer and contracts.

## Entry points

- `apps/electron/src/main/main.ts` — main process startup.
- `apps/electron/src/main/supervisor.ts` — Go core lifecycle management.
- `apps/electron/src/main/go-core-client.ts` — gRPC client.
- `apps/electron/src/preload/preload.ts` — single preload.
- `apps/electron/src/ipc/` — channels, handlers and events.

## How it works

- The supervisor starts and watches the Go core: it waits for `GO_CORE_READY`, `Ping`s every 5s and rotates the session token.
- The gRPC client talks to the core over the socket/named pipe.
- A single preload with `contextIsolation`.
- CSP defined in `apps/electron/src/window/csp.ts`.

## Conventions of this slice

- IPC uses typed channels defined in `apps/electron/src/ipc/channels.ts`.
- A single preload.
- `MOCK_GO_CORE=1` enables development without a real core.

## Dependencies

- **Upstream:** Go core (gRPC) and contracts.
- **Downstream:** Angular renderer.

## Known gaps & accepted debt

- M3 landed: `singularitree://` scheme registration behind the single-instance lock, Windows/Linux argv / `second-instance` handling, and the normalized `deeplink:open` IPC event forwarded to the renderer (the shell never runs Git) — [[adr-025-deep-links-and-clipboard-clone]]; the macOS `open-url` path was removed with macOS support — [[adr-0038-drop-macos-support-windows-and-linux-only]].
- e2e backed by mocks.
- Packaging (`electron-builder`) is configured for Windows `nsis` + `portable` and Linux `AppImage` + `deb`, all **UNSIGNED**; **all four targets are published** through GitHub Releases by the `v<version>` tag pipeline — the two Windows `.exe` files and the Linux `AppImage` + `deb` — built by two read-only jobs (`windows-latest`, `ubuntu-latest`) and published by a single `contents: write` job that runs no repository build code — [[adr-0037-windows-release-and-distribution]], [[adr-0038-drop-macos-support-windows-and-linux-only]], [[adr-0039-linux-release-and-distribution]].
