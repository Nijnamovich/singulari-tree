import { describe, expect, it } from 'vitest';
import { CommitFocusService } from './commit-focus.service';

describe('CommitFocusService', () => {
  it('queues a request and exposes it as pending', () => {
    const service = new CommitFocusService();

    service.request('repo-1', 'abc123');

    expect(service.pending()).toEqual({ repoId: 'repo-1', oid: 'abc123' });
  });

  it('ignores blank repo/oid values', () => {
    const service = new CommitFocusService();

    service.request('', 'abc');
    service.request('repo-1', '');

    expect(service.pending()).toBeNull();
  });

  it('replaces a previous request', () => {
    const service = new CommitFocusService();

    service.request('repo-1', 'a');
    service.request('repo-2', 'b');

    expect(service.pending()).toEqual({ repoId: 'repo-2', oid: 'b' });
  });

  it('consumes a matching request and clears it', () => {
    const service = new CommitFocusService();
    service.request('repo-1', 'abc');

    expect(service.consume('repo-1')).toBe('abc');
    expect(service.pending()).toBeNull();
  });

  it('does not consume a request for another repository', () => {
    const service = new CommitFocusService();
    service.request('repo-1', 'abc');

    expect(service.consume('repo-2')).toBeNull();
    expect(service.pending()).toEqual({ repoId: 'repo-1', oid: 'abc' });
  });

  it('clear drops the pending request', () => {
    const service = new CommitFocusService();
    service.request('repo-1', 'abc');

    service.clear();

    expect(service.pending()).toBeNull();
    expect(service.consume('repo-1')).toBeNull();
  });
});
