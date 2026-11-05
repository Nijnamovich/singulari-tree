import * as path from 'node:path';

/**
 * OS deep-link parsing/validation for the shell (ADR-025).
 *
 * Pure and Electron-free so it is unit-testable without an app runtime. The
 * shell parses and validates an incoming `singularitree://` URL and forwards a
 * **normalized** event to the renderer; it never runs Git and never executes a
 * shell. The renderer then routes the normalized payload to existing per-repo
 * IPC calls.
 *
 * Grammar (provisional scheme, reversible):
 *   singularitree://open?path=<abs>
 *   singularitree://open/<repo>/commit/<oid>
 *   singularitree://open/<repo>/branch/<name>
 *   singularitree://clone?url=<git-url>
 */

/** Provisional, reversible custom scheme (ADR-025). */
export const DEEP_LINK_SCHEME = 'singularitree';

/** Normalized deep link forwarded to the renderer over `deeplink:open`. */
export type DeepLink =
  | { kind: 'open-path'; path: string }
  | { kind: 'open-commit'; repo: string; oid: string }
  | { kind: 'open-branch'; repo: string; branch: string }
  | { kind: 'clone'; url: string };

/** Object-id shape: 4–64 hex chars (short oid through sha-256). */
const OID_RE = /^[0-9a-fA-F]{4,64}$/;

/** Explicit transport schemes accepted for a clone URL. */
const GIT_SCHEME_RE = /^(https?|ssh|git|file):\/\/[^\s]+$/i;

/** scp-like syntax: `user@host:path` (e.g. `git@github.com:org/repo.git`). */
const GIT_SCP_RE = /^[^\s@/]+@[^\s@/]+:[^\s]+$/;

/**
 * True when `value` is an absolute filesystem path.
 *
 * Accepts POSIX paths plus Windows drive/UNC forms even when running on POSIX,
 * because a deep link can target any platform the app runs on. The core's
 * `OpenRepository` guard remains the authoritative check.
 */
export function isAbsolutePath(value: string): boolean {
  if (!value) return false;
  if (path.isAbsolute(value)) return true;
  // Windows drive letter (`C:\…`, `C:/…`) or UNC (`\\server\share`).
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

/**
 * True when `value` looks like a plausible Git remote URL.
 *
 * Accepts `http(s)://`, `ssh://`, `git://`, `file://` and scp-like
 * `user@host:path` forms. Never used to contact a remote — validation only.
 */
export function isPlausibleGitRemoteUrl(value: string): boolean {
  const url = value.trim();
  if (!url || /\s/.test(url)) return false;
  return GIT_SCHEME_RE.test(url) || GIT_SCP_RE.test(url);
}

/** True when `name` is a plausible (local or remote-tracking) branch name. */
function isPlausibleRefName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('.') || name.endsWith('/')) {
    return false;
  }
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (/\s/.test(name)) return false;
  // Characters forbidden in a git ref: ~ ^ : ? * [ \ and control chars.
  return !/[~^:?*[\\\u0000-\u001f]/.test(name);
}

/** `decodeURIComponent` that never throws on malformed input. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse and validate a raw `singularitree://` URL into a normalized {@link DeepLink}.
 *
 * Returns `null` for anything malformed, an unknown host/form, a non-absolute
 * `path`, a non-hex oid, an implausible branch name or a non-git clone URL.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // Non-special schemes are not lower-cased by the URL parser; normalize here.
  const host = url.hostname.toLowerCase();

  if (host === 'open') {
    // Query form: `singularitree://open?path=<abs>`.
    if (url.searchParams.has('path')) {
      const abs = (url.searchParams.get('path') ?? '').trim();
      if (!isAbsolutePath(abs)) return null;
      return { kind: 'open-path', path: abs };
    }

    // Path form: `/open/<repo>/commit/<oid>` or `/open/<repo>/branch/<name>`.
    const segments = url.pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .map(safeDecode);
    if (segments.length !== 3) return null;
    const [repo, form, value] = segments;
    if (!repo || !value) return null;

    if (form === 'commit') {
      if (!OID_RE.test(value)) return null;
      return { kind: 'open-commit', repo, oid: value.toLowerCase() };
    }
    if (form === 'branch') {
      if (!isPlausibleRefName(value)) return null;
      return { kind: 'open-branch', repo, branch: value };
    }
    return null;
  }

  if (host === 'clone') {
    const cloneUrl = (url.searchParams.get('url') ?? '').trim();
    if (!isPlausibleGitRemoteUrl(cloneUrl)) return null;
    return { kind: 'clone', url: cloneUrl };
  }

  return null;
}

/**
 * Extract the first `singularitree://` URL from a process argv vector.
 *
 * Used for the Windows/Linux initial launch and the `second-instance` payload.
 * Returns `null` when the process was not started with a deep link.
 */
export function extractDeepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) {
      return arg;
    }
  }
  return null;
}
