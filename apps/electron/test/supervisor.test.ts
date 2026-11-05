import { describe, expect, it, vi } from 'vitest';

// supervisor.ts imports `electron` only for `app.getAppPath()`; stub it so the
// class can be exercised under plain Node without an Electron runtime.
vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/singularitree-test' },
}));

import { Supervisor, type SupervisorOptions } from '../src/main/supervisor';
import type { FsChangedPayload, ProgressPayload } from '../src/ipc/events';

/**
 * Guards the streaming dispatch contract: Fetch/Pull/Push are server-streaming
 * RPCs driven through `GoCoreClient.invokeStream`, with progress forwarded to
 * the injected sink. `git:watch` drives the background `Watch` stream through
 * `openStream` and forwards each `FsChangedEvent` to the `onFsChanged` sink.
 * Unary/auth channels keep the queue-while-not-ready behaviour
 * (ipc-strategy.md §2.2, §2.6).
 *
 * Residual: the watch forwarding is exercised with a fake client; there is no
 * live fsnotify-in-CI test (that needs a real go-core + OS watcher).
 */

const BASE_OPTIONS: SupervisorOptions = {
  goCoreBinary: '/nonexistent/go-core',
  grpcAddr: '127.0.0.1:0',
  httpAddr: '127.0.0.1:0',
};

function makeSupervisor(
  onProgress?: (payload: ProgressPayload) => void,
  onFsChanged?: (payload: FsChangedPayload) => void,
): Supervisor {
  return new Supervisor({ ...BASE_OPTIONS, onProgress, onFsChanged });
}

/** Resolve to a sentinel if the promise neither settles nor rejects promptly. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (e: { code?: string }) => `rejected:${e?.code ?? 'NO_CODE'}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

type ProgressFn = (p: { percent: number; message: string }) => void;
interface FakeClient {
  invokeStream: (
    rpc: string,
    payload: unknown,
    onProgress: ProgressFn,
  ) => Promise<void>;
  invoke?: (rpc: string, payload: unknown) => Promise<unknown>;
  openStream?: (
    rpc: string,
    payload: unknown,
    onData: (msg: { repoId: string; paths: string[] }) => void,
    onError: (err: unknown) => void,
  ) => { cancel(): void };
  close?: () => void;
}

/** Flip the supervisor to "ready" with a fake GitCore client. */
function armReady(supervisor: Supervisor, client: FakeClient): void {
  const internals = supervisor as unknown as { ready: boolean; client: FakeClient };
  internals.ready = true;
  internals.client = client;
}

describe('Supervisor.forwardToGo streaming dispatch', () => {
  it.each(['git:fetch', 'git:pull', 'git:push'])(
    'queues streaming channel %s while go-core is not ready (no NOT_IMPLEMENTED)',
    async (channel) => {
      const supervisor = makeSupervisor();
      const outcome = await settleWithin(supervisor.forwardToGo(channel, {}), 50);
      expect(outcome).toBe('pending');
    },
  );

  it.each([
    ['git:fetch', 'Fetch', 'fetch'],
    ['git:pull', 'Pull', 'pull'],
    ['git:push', 'Push', 'push'],
  ])(
    'drives %s over invokeStream and forwards progress as op=%s',
    async (channel, rpc, op) => {
      const progress: ProgressPayload[] = [];
      const supervisor = makeSupervisor((p) => progress.push(p));
      const invokeStream = vi.fn(
        async (_rpc: string, _payload: unknown, onProgress: ProgressFn) => {
          onProgress({ percent: 25, message: 'quarter' });
          onProgress({ percent: 100, message: 'done' });
        },
      );
      armReady(supervisor, { invokeStream });

      const payload = { repoId: 'repo-1', remote: 'origin' };
      await expect(supervisor.forwardToGo(channel, payload)).resolves.toBeUndefined();

      expect(invokeStream).toHaveBeenCalledWith(rpc, payload, expect.any(Function));
      expect(progress).toEqual([
        { op, percent: 25, message: 'quarter' },
        { op, percent: 100, message: 'done' },
      ]);
    },
  );

  it('propagates a stream error as the forwardToGo rejection', async () => {
    const supervisor = makeSupervisor();
    const invokeStream = vi.fn(async () => {
      throw { code: 'NETWORK_ERROR', message: 'boom', details: {} };
    });
    armReady(supervisor, { invokeStream });

    await expect(supervisor.forwardToGo('git:fetch', {})).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('still maps unary channels (no streaming dispatch, queues while not ready)', async () => {
    const supervisor = makeSupervisor();
    const outcome = await settleWithin(
      supervisor.forwardToGo('git:getStatus', { repoId: 'x' }),
      50,
    );
    expect(outcome).toBe('pending'); // queued while not ready
  });

  it('routes an auth channel without hitting the GitCore streaming path', async () => {
    const supervisor = makeSupervisor();
    const outcome = await settleWithin(supervisor.forwardToGo('auth:logout', {}), 50);
    expect(outcome).toBe('pending');
  });

  it('rejects an unknown channel with UNKNOWN_CHANNEL', async () => {
    const supervisor = makeSupervisor();
    await expect(supervisor.forwardToGo('git:nope', {})).rejects.toMatchObject({
      code: 'UNKNOWN_CHANNEL',
    });
  });
});

describe('Supervisor.forwardToGo Watch dispatch', () => {
  it('queues git:watch while go-core is not ready (ack resolves once running)', async () => {
    const supervisor = makeSupervisor();
    const outcome = await settleWithin(
      supervisor.forwardToGo('git:watch', { repoId: 'repo-1' }),
      50,
    );
    expect(outcome).toBe('pending');
  });

  it('starts the Watch stream, forwards FsChangedEvent to onFsChanged and acks immediately', async () => {
    const fsChanged: FsChangedPayload[] = [];
    const supervisor = makeSupervisor(undefined, (p) => fsChanged.push(p));
    let emit: ((ev: { repoId: string; paths: string[] }) => void) | undefined;
    const openStream = vi.fn(
      (
        _rpc: string,
        _payload: unknown,
        onData: (ev: { repoId: string; paths: string[] }) => void,
      ) => {
        emit = onData;
        return { cancel: vi.fn() };
      },
    );
    const invokeStream = vi.fn(async () => {});
    armReady(supervisor, { invokeStream, openStream });

    await expect(
      supervisor.forwardToGo('git:watch', { repoId: 'repo-1' }),
    ).resolves.toMatchObject({ ok: true, watching: 'repo-1' });

    // Watch must NOT be awaited through the generic streaming path.
    expect(invokeStream).not.toHaveBeenCalled();
    expect(openStream).toHaveBeenCalledWith(
      'Watch',
      { repoId: 'repo-1' },
      expect.any(Function),
      expect.any(Function),
    );

    emit?.({ repoId: 'repo-1', paths: ['a.ts', 'b.ts'] });
    expect(fsChanged).toEqual([{ repoId: 'repo-1', paths: ['a.ts', 'b.ts'] }]);
  });

  it('falls back to the requested repoId when the event omits it', async () => {
    const fsChanged: FsChangedPayload[] = [];
    const supervisor = makeSupervisor(undefined, (p) => fsChanged.push(p));
    let emit: ((ev: { repoId: string; paths: string[] }) => void) | undefined;
    const openStream = vi.fn(
      (
        _rpc: string,
        _payload: unknown,
        onData: (ev: { repoId: string; paths: string[] }) => void,
      ) => {
        emit = onData;
        return { cancel: vi.fn() };
      },
    );
    armReady(supervisor, { invokeStream: vi.fn(async () => {}), openStream });

    await supervisor.forwardToGo('git:watch', { repoId: 'repo-X' });
    emit?.({ repoId: '', paths: ['only-path.ts'] });
    expect(fsChanged).toEqual([{ repoId: 'repo-X', paths: ['only-path.ts'] }]);
  });

  it('replaces any existing watch on a new git:watch', async () => {
    const supervisor = makeSupervisor();
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const openStream = vi.fn(() => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return { cancel };
    });
    armReady(supervisor, { invokeStream: vi.fn(async () => {}), openStream });

    await supervisor.forwardToGo('git:watch', { repoId: 'a' });
    await supervisor.forwardToGo('git:watch', { repoId: 'b' });

    expect(cancels).toHaveLength(2);
    expect(cancels[0]).toHaveBeenCalledTimes(1); // previous stream cancelled
    expect(cancels[1]).not.toHaveBeenCalled(); // current stream still live
  });

  it('cancels the live watch on stop()', async () => {
    const supervisor = makeSupervisor();
    const cancel = vi.fn();
    const openStream = vi.fn(() => ({ cancel }));
    armReady(supervisor, {
      invokeStream: vi.fn(async () => {}),
      openStream,
      close: vi.fn(),
    });

    await supervisor.forwardToGo('git:watch', { repoId: 'a' });
    supervisor.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects git:watch with GO_CORE_UNAVAILABLE when ready but the client is gone', async () => {
    const supervisor = makeSupervisor();
    const internals = supervisor as unknown as { ready: boolean; client: unknown };
    internals.ready = true;
    internals.client = null;
    await expect(supervisor.forwardToGo('git:watch', { repoId: 'r' })).rejects.toMatchObject({
      code: 'GO_CORE_UNAVAILABLE',
    });
  });

  it.each([
    ['missing', {}],
    ['non-string', { repoId: 42 }],
    ['empty', { repoId: '' }],
  ])('rejects git:watch with INVALID_ARGUMENT when repoId is %s (W2)', async (_label, payload) => {
    const supervisor = makeSupervisor();
    const openStream = vi.fn(() => ({ cancel: vi.fn() }));
    armReady(supervisor, { invokeStream: vi.fn(async () => {}), openStream });

    await expect(supervisor.forwardToGo('git:watch', payload)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    // A malformed request must not open a stream or ack optimistically.
    expect(openStream).not.toHaveBeenCalled();
  });

  it('re-establishes the watch after a go-core restart (W1)', async () => {
    const supervisor = makeSupervisor();
    const openStream = vi.fn(() => ({ cancel: vi.fn() }));
    armReady(supervisor, { invokeStream: vi.fn(async () => {}), openStream });
    await supervisor.startWatch('repo-1');
    expect(openStream).toHaveBeenCalledTimes(1);

    const internals = supervisor as unknown as {
      stopWatch(): void;
      reestablishWatch(): void;
    };
    // Child loss tears down the live stream but must remember the watched repo.
    internals.stopWatch();
    const reconnected = vi.fn(() => ({ cancel: vi.fn() }));
    armReady(supervisor, { invokeStream: vi.fn(async () => {}), openStream: reconnected });

    internals.reestablishWatch();

    expect(reconnected).toHaveBeenCalledWith(
      'Watch',
      { repoId: 'repo-1' },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('does not re-establish a watch after stop() (W1)', async () => {
    const supervisor = makeSupervisor();
    const openStream = vi.fn(() => ({ cancel: vi.fn() }));
    armReady(supervisor, { invokeStream: vi.fn(async () => {}), openStream, close: vi.fn() });
    await supervisor.startWatch('repo-1');

    supervisor.stop();
    const internals = supervisor as unknown as { reestablishWatch(): void };
    internals.reestablishWatch();

    // stop() forgets the watched repo, so no second stream is opened.
    expect(openStream).toHaveBeenCalledTimes(1);
  });
});

describe('Supervisor.forwardToGo M2 unary dispatch', () => {
  it.each([
    ['git:stageHunk', 'StageHunk', { repoId: 'r', path: 'a.ts', hunkIndex: 1, lineIndices: [0] }],
    ['git:unstageHunk', 'UnstageHunk', { repoId: 'r', path: 'a.ts', hunkIndex: 1, lineIndices: [] }],
    ['git:discardHunk', 'DiscardHunk', { repoId: 'r', path: 'a.ts', hunkIndex: 0, lineIndices: [] }],
    ['git:discard', 'Discard', { repoId: 'r', paths: ['a.ts', 'b.ts'] }],
    ['git:reset', 'Reset', { repoId: 'r', to: 'HEAD~1', mode: 'SOFT' }],
    ['git:getCommitStats', 'GetCommitStats', { repoId: 'r', oids: ['abc123'] }],
  ])('forwards %s to %s on the GitCore client', async (channel, rpc, payload) => {
    const supervisor = makeSupervisor();
    const invoke = vi.fn(async () => ({ ok: true }));
    armReady(supervisor, { invokeStream: vi.fn(async () => {}), invoke });

    await expect(supervisor.forwardToGo(channel, payload)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith(rpc, payload);
  });
});
