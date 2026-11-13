import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// handlers.ts imports `electron`; stub the native surface so the module can be
// exercised under plain Node. `vi.mock` is hoisted, so the mock factory is
// defined through `vi.hoisted`.
const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
}));

import { CHANNELS } from '../src/ipc/channels';
import {
  decodeIpcError,
  markSilentCancellation,
  type AppErrorPayload,
} from '../src/ipc/app-error';
import { registerIpcHandlers } from '../src/ipc/handlers';

/**
 * Guards the IPC error boundary: a shell-initiated cancellation (flagged by
 * `markSilentCancellation` when the gRPC channel is torn down) must resolve
 * instead of throwing, because Electron logs every thrown `ipcMain.handle`
 * listener as `Error occurred in handler for '…'` — a shutdown would otherwise
 * look like a product failure. Genuine errors keep the frozen `ST_APP_ERROR:`
 * envelope, and an unflagged CANCELLED keeps it too.
 */

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

function handlerFor(channel: string): Handler {
  const call = handleMock.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`handler not registered for ${channel}`);
  return call[1] as Handler;
}

/** Rejection payload carried by the thrown AppError `Error`. */
function rejectionPayload(err: unknown): AppErrorPayload {
  return decodeIpcError(err);
}

/** Await `promise`, returning the rejection reason (fails the test on resolve). */
async function settledRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the handler to reject');
}

describe('registerIpcHandlers error boundary', () => {
  beforeEach(() => {
    handleMock.mockReset();
    removeHandlerMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a shell teardown cancellation without logging an error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cancelled = { code: 'CANCELLED', message: 'Call cancelled', details: {} };
    markSilentCancellation(cancelled);
    registerIpcHandlers(() => Promise.reject(cancelled));

    const handler = handlerFor(CHANNELS.getCommitStats);

    // Resolving (rather than throwing) is what keeps Electron's own
    // `-ipc-invoke` error path silent; it is the only way a handler can avoid
    // `Error occurred in handler for '…'` on stderr.
    await expect(handler({}, { repoId: 'r', oids: ['a'] })).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps a genuine failure as the frozen AppError envelope', async () => {
    registerIpcHandlers(() =>
      Promise.reject({ code: 'GIT_FAILED', message: 'numstat failed', details: {} }),
    );

    const handler = handlerFor(CHANNELS.getCommitStats);
    const err = await settledRejection(handler({}, { repoId: 'r', oids: ['a'] }));

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AppError');
    expect(rejectionPayload(err)).toEqual({
      code: 'GIT_FAILED',
      message: 'numstat failed',
      details: {},
    });
  });

  it('does not silence a CANCELLED that was not flagged by our own teardown', async () => {
    registerIpcHandlers(() =>
      Promise.reject({ code: 'CANCELLED', message: 'Call cancelled', details: {} }),
    );

    const handler = handlerFor(CHANNELS.getCommitStats);
    const err = await settledRejection(handler({}, { repoId: 'r', oids: ['a'] }));

    expect(rejectionPayload(err).code).toBe('CANCELLED');
  });
});
