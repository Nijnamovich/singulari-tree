import { describe, expect, it } from 'vitest';
import { baseName, buildRepoDeepLink, isPlausibleGitRemoteUrl } from './git-url';

/**
 * Guards the renderer's git-URL validation (ADR-025). Mirrors the shell's
 * `isPlausibleGitRemoteUrl`; validation only — the renderer never contacts Git.
 */
describe('isPlausibleGitRemoteUrl', () => {
  it.each([
    ['https://example.com/me/app.git', true],
    ['http://example.com/me/app', true],
    ['ssh://git@example.com/me/app.git', true],
    ['git://example.com/me/app.git', true],
    ['file:///srv/git/app.git', true],
    ['git@github.com:org/repo.git', true],
    ['ftp://example.com/x', false],
    ['/local/path', false],
    ['not a url', false],
    ['', false],
    ['   ', false],
  ])('classifies %s as %s', (value, expected) => {
    expect(isPlausibleGitRemoteUrl(value)).toBe(expected);
  });

  it('trims before validating', () => {
    expect(isPlausibleGitRemoteUrl('  https://example.com/x.git  ')).toBe(true);
  });
});

describe('baseName', () => {
  it.each([
    ['/tmp/local-1', 'local-1'],
    ['/tmp/local-1/', 'local-1'],
    ['C:\\repos\\app', 'app'],
    ['app', 'app'],
    ['', ''],
  ])('resolves the basename of %s', (value, expected) => {
    expect(baseName(value)).toBe(expected);
  });
});

describe('buildRepoDeepLink', () => {
  it('percent-encodes the absolute path into the open form', () => {
    expect(buildRepoDeepLink('/home/me/my app')).toBe(
      'singularitree://open?path=%2Fhome%2Fme%2Fmy%20app',
    );
  });
});
