import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import {
  DEFAULT_STREAM_TIMEOUT_MS,
  GoCoreClient,
  type AppError,
  type Progress,
} from '../src/main/go-core-client';

/**
 * Unit coverage for `GoCoreClient.invokeStream` using a fake readable stream
 * (no real go-core): data → onProgress, error → reject(normalizeGrpcError),
 * end → resolve. Also checks that `invoke()` routes the real Fetch/Pull/Push
 * streams to `invokeStream` while still rejecting the unimplemented ones.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
const protoDir = path.join(repoRoot, 'libs/contracts/proto');

function makeClient(): GoCoreClient {
  return new GoCoreClient({ protoDir });
}

/** Replace the private channel/client with a fake so no real socket is used. */
function arm(
  client: GoCoreClient,
  methods: Record<string, unknown>,
): void {
  const internals = client as unknown as {
    client: unknown;
    metadata: grpc.Metadata;
    connected: boolean;
  };
  internals.client = methods;
  internals.metadata = new grpc.Metadata();
  internals.metadata.set('authorization', 'Bearer test-token');
  internals.connected = true;
}

/** Minimal stand-in for grpc-js `ClientReadableStream` (EventEmitter). */
class FakeStream extends EventEmitter {
  cancel = vi.fn();
}

describe('GoCoreClient.invokeStream', () => {
  it('calls onProgress per data event and resolves on end (EOF)', async () => {
    const client = makeClient();
    const stream = new FakeStream();
    arm(client, { Fetch: () => stream });

    const seen: Progress[] = [];
    const promise = client.invokeStream(
      'Fetch',
      { repoId: 'r', remote: 'origin' },
      (p) => seen.push(p),
    );

    stream.emit('data', { percent: 42, message: 'mid' });
    stream.emit('data', { percent: 100, message: 'done' });
    stream.emit('end');

    await expect(promise).resolves.toBeUndefined();
    expect(seen).toEqual([
      { percent: 42, message: 'mid' },
      { percent: 100, message: 'done' },
    ]);
  });

  it('rejects with a normalized AppError on stream error', async () => {
    const client = makeClient();
    const stream = new FakeStream();
    arm(client, { Push: () => stream });

    const promise = client.invokeStream('Push', {}, () => {});
    const err = Object.assign(new Error('boom'), {
      code: grpc.status.UNAVAILABLE,
      details: 'unavailable',
    });
    stream.emit('error', err);

    await expect(promise).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'unavailable',
    });
  });

  it('passes a fresh metadata instance per call (never the shared one)', async () => {
    const client = makeClient();
    const captured: grpc.Metadata[] = [];
    const streams: FakeStream[] = [];
    const factory = (_req: unknown, md: grpc.Metadata): FakeStream => {
      captured.push(md);
      const s = new FakeStream();
      streams.push(s);
      return s;
    };
    arm(client, { Fetch: factory });

    const p1 = client.invokeStream('Fetch', {}, () => {});
    const p2 = client.invokeStream('Fetch', {}, () => {});
    expect(captured).toHaveLength(2);
    expect(captured[0]).not.toBe(captured[1]);
    expect(captured[0].get('authorization')[0]?.toString()).toBe('Bearer test-token');

    streams.forEach((s) => s.emit('end'));
    await Promise.all([p1, p2]);
  });

  it('rejects UNKNOWN_RPC for a method absent from the service', async () => {
    const client = makeClient();
    arm(client, {});
    await expect(client.invokeStream('Nope', {}, () => {})).rejects.toMatchObject({
      code: 'UNKNOWN_RPC',
    });
  });

  it('applies a bounded default stream deadline so a stalled transport fails', async () => {
    const client = makeClient();
    let captured: grpc.CallOptions | undefined;
    const stream = new FakeStream();
    const factory = (
      _req: unknown,
      _md: grpc.Metadata,
      options: grpc.CallOptions,
    ): FakeStream => {
      captured = options;
      return stream;
    };
    arm(client, { Fetch: factory });

    const before = Date.now();
    const promise = client.invokeStream('Fetch', {}, () => {});
    expect(captured?.deadline).toBeInstanceOf(Date);
    const deltaMs = (captured?.deadline as Date).getTime() - before;
    expect(deltaMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThanOrEqual(DEFAULT_STREAM_TIMEOUT_MS + 1000);

    stream.emit('end');
    await promise;
  });

  it('honours an explicit streamTimeoutMs of 0 (deadline disabled)', async () => {
    const client = new GoCoreClient({ protoDir, streamTimeoutMs: 0 });
    let captured: grpc.CallOptions | undefined;
    const stream = new FakeStream();
    const factory = (
      _req: unknown,
      _md: grpc.Metadata,
      options: grpc.CallOptions,
    ): FakeStream => {
      captured = options;
      return stream;
    };
    arm(client, { Fetch: factory });

    const promise = client.invokeStream('Fetch', {}, () => {});
    expect(captured?.deadline).toBeUndefined();

    stream.emit('end');
    await promise;
  });
});

describe('GoCoreClient.invoke streaming routing', () => {
  it('routes Fetch/Pull/Push through invokeStream and resolves at EOF', async () => {
    const client = makeClient();
    const stream = new FakeStream();
    arm(client, { Fetch: () => stream });

    const promise = client.invoke('Fetch', { repoId: 'r', remote: 'origin' });
    stream.emit('end');
    await expect(promise).resolves.toBeUndefined();
  });

  it('still rejects StreamCommits with NOT_IMPLEMENTED', async () => {
    const client = makeClient();
    arm(client, {});
    await expect(client.invoke('StreamCommits', {})).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });
});

describe('GoCoreClient.openStream (background Watch)', () => {
  it('forwards each data message, applies no deadline, and cancels idempotently', () => {
    const client = makeClient();
    const stream = new FakeStream();
    let captured: grpc.CallOptions | undefined;
    arm(client, {
      Watch: (_req: unknown, _md: grpc.Metadata, options: grpc.CallOptions) => {
        captured = options;
        return stream;
      },
    });

    const seen: Array<{ repoId: string; paths: string[] }> = [];
    const handle = client.openStream<{ repoId: string; paths: string[] }>(
      'Watch',
      { repoId: 'repo-1' },
      (msg) => seen.push(msg),
    );

    // A watch is long-lived: unlike Fetch/Push/Pull no bounded deadline is set.
    expect(captured?.deadline).toBeUndefined();

    stream.emit('data', { repoId: 'repo-1', paths: ['a.ts'] });
    expect(seen).toEqual([{ repoId: 'repo-1', paths: ['a.ts'] }]);

    handle.cancel();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    handle.cancel(); // idempotent
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('routes stream errors to onError and swallows them after cancel', () => {
    const client = makeClient();
    const stream = new FakeStream();
    arm(client, { Watch: () => stream });

    const errors: AppError[] = [];
    const handle = client.openStream('Watch', { repoId: 'r' }, () => {}, (e) =>
      errors.push(e),
    );

    stream.emit(
      'error',
      Object.assign(new Error('boom'), {
        code: grpc.status.UNAVAILABLE,
        details: 'unavailable',
      }),
    );
    expect(errors).toEqual([
      expect.objectContaining({ code: 'UNAVAILABLE', message: 'unavailable' }),
    ]);

    handle.cancel();
    // grpc-js reports CANCELLED on teardown; that is deliberate, not an error.
    stream.emit('error', Object.assign(new Error('cancel'), { code: grpc.status.CANCELLED }));
    expect(errors).toHaveLength(1);
  });

  it('throws UNKNOWN_RPC for a method absent from the service', () => {
    const client = makeClient();
    arm(client, {});
    let thrown: unknown;
    try {
      client.openStream('Nope', {}, () => {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'UNKNOWN_RPC' });
  });
});
