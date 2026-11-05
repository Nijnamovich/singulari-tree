/**
 * Git remote-URL and deep-link helpers (ADR-025).
 *
 * Pure functions shared by the clipboard-clone affordance and deep-link
 * routing. Mirrors the shell's validation (`apps/electron/src/main/deep-link.ts`)
 * so the renderer can defensively re-check a payload it receives. The renderer
 * never contacts Git: these only classify strings.
 */

/** Explicit transport schemes accepted for a clone URL. */
const GIT_SCHEME_RE = /^(https?|ssh|git|file):\/\/[^\s]+$/i;

/** scp-like syntax: `user@host:path` (e.g. `git@github.com:org/repo.git`). */
const GIT_SCP_RE = /^[^\s@/]+@[^\s@/]+:[^\s]+$/;

/**
 * True when `value` looks like a plausible Git remote URL.
 *
 * Accepts `http(s)://`, `ssh://`, `git://`, `file://` and scp-like
 * `user@host:path` forms. Validation only — never used to contact a remote.
 */
export function isPlausibleGitRemoteUrl(value: string): boolean {
  const url = value.trim();
  if (!url || /\s/.test(url)) return false;
  return GIT_SCHEME_RE.test(url) || GIT_SCP_RE.test(url);
}

/** Basename of a filesystem path, handling both `/` and `\` separators. */
export function baseName(fsPath: string): string {
  const trimmed = fsPath.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/**
 * Build a shareable `singularitree://open?path=<abs>` deep link for a
 * repository filesystem path. The path is percent-encoded so it survives the
 * URL query intact.
 */
export function buildRepoDeepLink(fsPath: string): string {
  return `singularitree://open?path=${encodeURIComponent(fsPath)}`;
}
