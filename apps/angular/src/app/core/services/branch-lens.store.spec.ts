import { describe, expect, it } from 'vitest';
import { BranchLensStore } from './branch-lens.store';

describe('BranchLensStore', () => {
  it('starts inactive with an empty request scope', () => {
    const store = new BranchLensStore();

    expect(store.ref()).toBeNull();
    expect(store.kind()).toBeNull();
    expect(store.active()).toBe(false);
    expect(store.refs()).toEqual([]);
  });

  it('sets a local and a remote lens and exposes the wire refs shape', () => {
    const store = new BranchLensStore();

    store.set('feature/x', 'local');
    expect(store.ref()).toBe('feature/x');
    expect(store.kind()).toBe('local');
    expect(store.active()).toBe(true);
    expect(store.refs()).toEqual(['feature/x']);

    store.set('origin/main', 'remote');
    expect(store.kind()).toBe('remote');
    expect(store.refs()).toEqual(['origin/main']);
  });

  it('is idempotent for the same ref+kind', () => {
    const store = new BranchLensStore();
    store.set('feature/x', 'local');
    const ref = store.ref;

    store.set('feature/x', 'local');

    // Same values, and no write churn: the signal reference is untouched.
    expect(store.ref()).toBe('feature/x');
    expect(store.kind()).toBe('local');
    expect(store.ref).toBe(ref);
  });

  it('toggles the same ref off and a different ref on', () => {
    const store = new BranchLensStore();
    store.set('feature/x', 'local');

    store.toggle('feature/x', 'local');
    expect(store.active()).toBe(false);
    expect(store.kind()).toBeNull();

    store.toggle('feature/x', 'local');
    expect(store.active()).toBe(true);

    store.toggle('origin/main', 'remote');
    expect(store.ref()).toBe('origin/main');
    expect(store.kind()).toBe('remote');
  });

  it('clears the lens and the request scope together', () => {
    const store = new BranchLensStore();
    store.set('origin/main', 'remote');

    store.clear();

    expect(store.ref()).toBeNull();
    expect(store.kind()).toBeNull();
    expect(store.active()).toBe(false);
    expect(store.refs()).toEqual([]);
  });
});
