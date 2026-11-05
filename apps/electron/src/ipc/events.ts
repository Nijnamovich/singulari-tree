import type { BrowserWindow } from 'electron';
import type { DeepLink } from '../main/deep-link';

/**
 * webContents.send definitions (ipc-strategy.md §1.2 — events.ts).
 * Electron -> renderer push channels.
 */

export const EVENT_CHANNELS = {
  repoChanged: 'repo:changed',
  fsChanged: 'fs:changed',
  gitProgress: 'git:progress',
  // One-way push: a validated OS deep link normalized by the shell (ADR-025).
  // Intentionally an event, not an RPC — the frozen 43-channel RPC surface is
  // untouched.
  deepLink: 'deeplink:open',
} as const;

export type RepoChangedPayload = { repoId: string; reason: 'commit' | 'checkout' | 'fetch' | 'watcher' };
export type FsChangedPayload = { repoId: string; paths: string[] };
export type ProgressPayload = { op: string; percent: number; message: string };
/** Normalized deep link forwarded to the renderer (mirrors `main/deep-link.ts`). */
export type DeepLinkPayload = DeepLink;

export function sendRepoChanged(win: BrowserWindow, payload: RepoChangedPayload): void {
  win.webContents.send(EVENT_CHANNELS.repoChanged, payload);
}

export function sendFsChanged(win: BrowserWindow, payload: FsChangedPayload): void {
  win.webContents.send(EVENT_CHANNELS.fsChanged, payload);
}

export function sendProgress(win: BrowserWindow, payload: ProgressPayload): void {
  win.webContents.send(EVENT_CHANNELS.gitProgress, payload);
}

export function sendDeepLink(win: BrowserWindow, payload: DeepLinkPayload): void {
  win.webContents.send(EVENT_CHANNELS.deepLink, payload);
}
