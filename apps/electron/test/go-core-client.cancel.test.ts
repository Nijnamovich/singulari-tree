import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { isSilentCancellation } from '../src/ipc/app-error';
import { GoCoreClient } from '../src/main/go-core-client';

/**
 * Guards the CANCELLED classification of `GoCoreClient`: grpc-js reports
 * CANCELLED for every call a channel teardown aborts, but only a *shutdown*
 * (`close(true)`) may flag it as benign — the IPC boundary needs to resolve
 * those silently. A reconnect close and any other gRPC failure must stay
 * ordinary errors so the renderer still learns the operation did not run.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const protoDir = path.join(path.resolve(testDir, '../../..'), 'libs/contracts/proto');

function makeClient(): GoCoreClient {
  return new GoCoreClient({ protoDir });
}

/** Replace the private channel/client with a fake so no real socket is used. */
function arm(client: GoCoreClient, methods: Record<string, unknown>): void {
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

type Cb = (err: grpc.ServiceError | null, res: unknown) => void;

/** Fake unary transport: capture the callback so the test controls the failure. */
function armUnary(client: GoCoreClient): (err: grpc.ServiceError | null) => void {
  let callback: Cb | null = null;
  arm(client, {
    close: vi.fn(),
    GetCommitStats: (
      _req: unknown,
      _md: unknown,
      _options: unknown,
      cb: Cb,
    ): void => {
      callback = cb;
    },
  });
  return (err) => {
    if (!callback) throw new Error('GetCommitStats was not dispatched');
    callback(err, null);
  };
}

function cancelledError(): grpc.ServiceError {
  return Object.assign(new Error('Call cancelled'), {
    code: grpc.status.CANCELLED,
    details: 'Call cancelled',
  }) as unknown as grpc.ServiceError;
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string };
  }
  throw new Error('expected the call to reject');
}

const STATS_REQUEST = { repoId: 'repo-1', oids: ['a'.repeat(40)] };

describe('GoCoreClient cancellation classification', () => {
  it('flags the CANCELLED of a shutdown teardown as benign', async () => {
    const client = makeClient();
    const deliver = armUnary(client);

    const promise = client.getCommitStats(STATS_REQUEST);
    client.close(true);
    deliver(cancelledError());

    const err = await rejection(promise);
    expect(err.code).toBe('CANCELLED');
    expect(isSilentCancellation(err)).toBe(true);
  });

  it('does not flag a CANCELLED caused by a reconnect close', async () => {
    const client = makeClient();
    const deliver = armUnary(client);

    const promise = client.getCommitStats(STATS_REQUEST);
    // `connect()` closes the previous channel this way: the caller is still
    // waiting and must see the failure, so it is not a shutdown.
    client.close();
    deliver(cancelledError());

    const err = await rejection(promise);
    expect(err.code).toBe('CANCELLED');
    expect(isSilentCancellation(err)).toBe(false);
  });

  it('never flags a real failure, even during a silent teardown', async () => {
    const client = makeClient();
    const deliver = armUnary(client);

    const promise = client.getCommitStats(STATS_REQUEST);
    client.close(true);
    deliver(
      Object.assign(new Error('deadline'), {
        code: grpc.status.DEADLINE_EXCEEDED,
        details: 'deadline exceeded',
      }) as unknown as grpc.ServiceError,
    );

    const err = await rejection(promise);
    expect(err.code).toBe('DEADLINE_EXCEEDED');
    expect(isSilentCancellation(err)).toBe(false);
  });

  it('flags the CANCELLED of a shutdown teardown on a streaming call too', async () => {
    const client = makeClient();
    const stream = Object.assign(new EventEmitter(), { cancel: vi.fn() });
    arm(client, { close: vi.fn(), Fetch: () => stream });

    const promise = client.invokeStream('Fetch', { repoId: 'repo-1' }, () => {});
    client.close(true);
    stream.emit('error', cancelledError());

    const err = await rejection(promise);
    expect(err.code).toBe('CANCELLED');
    expect(isSilentCancellation(err)).toBe(true);
  });
});
