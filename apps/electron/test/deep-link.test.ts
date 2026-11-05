import { describe, expect, it } from 'vitest';
import {
  DEEP_LINK_SCHEME,
  extractDeepLinkFromArgv,
  isAbsolutePath,
  isPlausibleGitRemoteUrl,
  parseDeepLink,
} from '../src/main/deep-link';

/**
 * Guards the ADR-025 deep-link grammar. The shell parses and validates an
 * incoming `singularitree://` URL into a normalized payload; every malformed,
 * unknown or unsafe form must be rejected so the renderer only ever routes a
 * trusted shape. The parser is pure and never runs Git.
 */
describe('parseDeepLink', () => {
  it('parses the open-by-absolute-path form', () => {
    expect(parseDeepLink('singularitree://open?path=/home/me/projects/app')).toEqual({
      kind: 'open-path',
      path: '/home/me/projects/app',
    });
  });

  it('accepts a Windows absolute path', () => {
    expect(parseDeepLink('singularitree://open?path=C:\\Users\\me\\repo')).toEqual({
      kind: 'open-path',
      path: 'C:\\Users\\me\\repo',
    });
  });

  it('parses the open-commit form and lower-cases the oid', () => {
    expect(parseDeepLink('singularitree://open/app/commit/A1B2C3D')).toEqual({
      kind: 'open-commit',
      repo: 'app',
      oid: 'a1b2c3d',
    });
  });

  it('parses the open-branch form, preserving slashes and decoding', () => {
    expect(parseDeepLink('singularitree://open/app/branch/feature%2Fx')).toEqual({
      kind: 'open-branch',
      repo: 'app',
      branch: 'feature/x',
    });
  });

  it('parses the clone form with an https URL', () => {
    expect(parseDeepLink('singularitree://clone?url=https://example.com/me/app.git')).toEqual({
      kind: 'clone',
      url: 'https://example.com/me/app.git',
    });
  });

  it('parses the clone form with an scp-like URL', () => {
    expect(parseDeepLink('singularitree://clone?url=git@github.com:org/repo.git')).toEqual({
      kind: 'clone',
      url: 'git@github.com:org/repo.git',
    });
  });

  it('normalizes an upper-case scheme/host', () => {
    expect(parseDeepLink('SINGULARITREE://OPEN?path=/x')).toEqual({
      kind: 'open-path',
      path: '/x',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseDeepLink('  singularitree://open?path=/x  ')).toEqual({
      kind: 'open-path',
      path: '/x',
    });
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['not a URL', 'not-a-url'],
    ['unknown scheme', 'https://example.com/open?path=/x'],
    ['unknown host', 'singularitree://bogus?path=/x'],
    ['scheme without authority', 'singularitree:open?path=/x'],
    ['open with neither path nor segments', 'singularitree://open'],
    ['open with a relative path', 'singularitree://open?path=relative/path'],
    ['open with an empty path', 'singularitree://open?path='],
    ['open with too few segments', 'singularitree://open/app/commit'],
    ['open with too many segments', 'singularitree://open/app/commit/abc/extra'],
    ['open with an unknown form', 'singularitree://open/app/tag/v1'],
    ['commit with a non-hex oid', 'singularitree://open/app/commit/zzzz'],
    ['commit with a too-short oid', 'singularitree://open/app/commit/ab'],
    ['branch with an invalid name', 'singularitree://open/app/branch/feat..ure'],
    ['branch starting with a dash', 'singularitree://open/app/branch/-bad'],
    ['clone without a url', 'singularitree://clone'],
    ['clone with a non-git url', 'singularitree://clone?url=ftp://example.com/x'],
    ['clone with a bare path', 'singularitree://clone?url=/local/path'],
  ])('rejects %s', (_label, raw) => {
    expect(parseDeepLink(raw)).toBeNull();
  });

  it('rejects a non-string input', () => {
    expect(parseDeepLink(undefined as unknown as string)).toBeNull();
  });
});

describe('isAbsolutePath', () => {
  it.each([
    ['/home/me', true],
    ['C:\\repo', true],
    ['C:/repo', true],
    ['\\\\server\\share', true],
    ['relative/path', false],
    ['', false],
  ])('classifies %s as %s', (value, expected) => {
    expect(isAbsolutePath(value)).toBe(expected);
  });
});

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
    ['has spaces', false],
    ['', false],
  ])('classifies %s as %s', (value, expected) => {
    expect(isPlausibleGitRemoteUrl(value)).toBe(expected);
  });
});

describe('extractDeepLinkFromArgv', () => {
  it('finds the first deep link in the argument vector', () => {
    expect(
      extractDeepLinkFromArgv(['/usr/bin/app', '--flag', 'singularitree://open?path=/x']),
    ).toBe('singularitree://open?path=/x');
  });

  it('matches case-insensitively', () => {
    expect(extractDeepLinkFromArgv(['SINGULARITREE://open?path=/x'])).toBe(
      'SINGULARITREE://open?path=/x',
    );
  });

  it('returns null when no deep link is present', () => {
    expect(extractDeepLinkFromArgv(['/usr/bin/app', '--flag'])).toBeNull();
  });

  it('ignores non-string arguments', () => {
    expect(extractDeepLinkFromArgv([null as unknown as string, 42 as unknown as string])).toBeNull();
  });

  it('exposes the provisional scheme name', () => {
    expect(DEEP_LINK_SCHEME).toBe('singularitree');
  });
});
