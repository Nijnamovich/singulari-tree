import { beforeEach, describe, expect, it, vi } from 'vitest';

// handlers.ts imports `{ ipcMain } from 'electron'`; stub it so the module can
// be exercised under plain Node without an Electron runtime.
const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
}));

import type { ChannelName } from '../src/ipc/channels';
import {
  APP_ERROR_PREFIX,
  decodeIpcError,
  encodeIpcError,
  isAppErrorPayload,
  normalizeAppError,
} from '../src/ipc/app-error';
import { registerIpcHandlers } from '../src/ipc/handlers';

/**
 * Guards the frozen IPC error envelope: a plain-object AppError must cross
 * `ipcMain.handle` as a real Error carrying ST_APP_ERROR:<json>, never as
 * `[object Object]` (ipc-strategy.md §2.5).
 */

type Forward = (channel: ChannelName, payload: unknown) => Promise<unknown>;
type RegisteredHandler = (event: unknown, payload: unknown) => Promise<unknown>;

/** Register handlers and index them by channel. */
function register(forward: Forward): Map<string, RegisteredHandler> {
  handleMock.mockClear();
  removeHandlerMock.mockClear();
  registerIpcHandlers(forward);
  const handlers = new Map<string, RegisteredHandler>();
  for (const call of handleMock.mock.calls) {
    handlers.set(call[0] as string, call[1] as RegisteredHandler);
  }
  return handlers;
}

/** Invoke a handler and return the rejection value (or undefined on success). */
async function invoke(
  handler: RegisteredHandler,
  payload: unknown,
): Promise<unknown> {
  try {
    await handler({}, payload);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('registerIpcHandlers error normalization', () => {
  beforeEach(() => {
    handleMock.mockClear();
    removeHandlerMock.mockClear();
  });

  it('encodes a plain-object reject as a decodable AppError payload', async () => {
    const forward = vi
      .fn()
      .mockRejectedValue({
        code: 'NOT_IMPLEMENTED',
        message: 'x',
        details: { a: 1 },
      });
    const handler = register(forward).get('git:getBranches');
    expect(handler).toBeDefined();

    const caught = await invoke(handler as RegisteredHandler, {});

    expect(caught).toBeInstanceOf(Error);
    expect(decodeIpcError(caught)).toEqual({
      code: 'NOT_IMPLEMENTED',
      message: 'x',
      details: { a: 1 },
    });
  });

  it.each([
    ['a bare string', 'boom', 'boom'],
    ['undefined', undefined, 'undefined'],
  ])(
    'decodes %s rejection to UNKNOWN without [object Object]',
    async (_label, rejection, expectedMessage) => {
      const forward = vi.fn().mockRejectedValue(rejection);
      const handler = register(forward).get('git:getBranches');

      const caught = await invoke(handler as RegisteredHandler, {});
      const decoded = decodeIpcError(caught);

      expect(decoded.code).toBe('UNKNOWN');
      expect(decoded.message).toBe(expectedMessage);
      expect(decoded.message).not.toContain('[object Object]');
    },
  );

  it('drops unrelated fields so secrets never leak', async () => {
    const forward = vi.fn().mockRejectedValue({
      code: 'OPS',
      message: 'm',
      details: {},
      token: 'secret',
    });
    const handler = register(forward).get('git:getBranches');

    const caught = await invoke(handler as RegisteredHandler, {});
    const decoded = decodeIpcError(caught);

    expect(decoded).not.toHaveProperty('token');
    expect(JSON.stringify(decoded)).not.toContain('secret');
    expect(decoded).toEqual({ code: 'OPS', message: 'm', details: {} });
  });

  it('encodes validation failures as INVALID_ARGUMENT without forwarding', async () => {
    const forward = vi.fn();
    const handler = register(forward).get('git:getBranches');

    const caught = await invoke(handler as RegisteredHandler, 42);

    expect(forward).not.toHaveBeenCalled();
    expect(decodeIpcError(caught).code).toBe('INVALID_ARGUMENT');
  });

  it('decodes an Electron-wrapped Error message', () => {
    const err = new Error(
      "Error invoking remote method 'git:getBranches': Error: ST_APP_ERROR:" +
        '{"code":"REPO_NOT_FOUND","message":"m","details":{}}',
    );

    expect(decodeIpcError(err)).toEqual({
      code: 'REPO_NOT_FOUND',
      message: 'm',
      details: {},
    });
  });
});

describe('normalizeAppError / encodeIpcError', () => {
  it('keeps code/details from an Error instance', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'REPO_NOT_FOUND',
      details: { repo_id: 'abc' },
    });

    expect(normalizeAppError(err)).toEqual({
      code: 'REPO_NOT_FOUND',
      message: 'boom',
      details: { repo_id: 'abc' },
    });
  });

  it('defaults Error code to INTERNAL and details to {}', () => {
    expect(normalizeAppError(new Error('boom'))).toEqual({
      code: 'INTERNAL',
      message: 'boom',
      details: {},
    });
  });

  it('builds a named Error carrying the prefix + JSON payload', () => {
    const encoded = encodeIpcError({ code: 'X', message: 'y', details: { z: 1 } });

    expect(encoded).toBeInstanceOf(Error);
    expect(encoded.name).toBe('AppError');
    expect(encoded.message.startsWith(APP_ERROR_PREFIX)).toBe(true);
    expect(decodeIpcError(encoded)).toEqual({
      code: 'X',
      message: 'y',
      details: { z: 1 },
    });
  });

  it('does not leak unrelated plain-object fields into the message', () => {
    const payload = JSON.parse(
      encodeIpcError({ code: 'X', details: {}, token: 'secret' }).message.slice(
        APP_ERROR_PREFIX.length,
      ),
    ) as Record<string, unknown>;

    expect(payload).not.toHaveProperty('token');
    expect(JSON.stringify(payload)).not.toContain('secret');
  });

  it('isAppErrorPayload accepts shaped plain objects only', () => {
    expect(isAppErrorPayload({ code: 'X', message: 'y', details: {} })).toBe(true);
    expect(isAppErrorPayload({ code: 'X' })).toBe(false);
    expect(isAppErrorPayload(new Error('x'))).toBe(false);
    expect(isAppErrorPayload(null)).toBe(false);
  });
});
