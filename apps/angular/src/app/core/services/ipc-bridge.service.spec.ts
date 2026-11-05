import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcBridge, toAppError } from './ipc-bridge.service';

/** Frozen envelope prefix, mirrored from the Electron main process. */
const PREFIX = 'ST_APP_ERROR:';

/** Minimal GitClientApi surface for the invoke-normalization test. */
function installBridge(impl: Record<string, (req: unknown) => unknown>): void {
  (window as unknown as { gitClientApi?: unknown }).gitClientApi = impl;
}

function clearBridge(): void {
  delete (window as unknown as { gitClientApi?: unknown }).gitClientApi;
}

describe('toAppError', () => {
  it('passes a shaped plain object through, including details', () => {
    expect(toAppError({ code: 'GIT_FAILED', message: 'boom', details: { repoId: 'r1' } })).toEqual({
      code: 'GIT_FAILED',
      message: 'boom',
      details: { repoId: 'r1' },
    });
  });

  it('defaults code/message/details for an empty plain object', () => {
    expect(toAppError({})).toEqual({ code: 'UNKNOWN', message: 'Unknown error', details: {} });
  });

  it('drops a non-plain-object details and defaults it to {}', () => {
    expect(toAppError({ code: 'X', message: 'y', details: 'nope' })).toEqual({
      code: 'X',
      message: 'y',
      details: {},
    });
  });

  it('decodes an Electron-wrapped prefixed Error', () => {
    const payload = { code: 'REPO_NOT_FOUND', message: 'missing', details: { repoId: 'abc' } };
    const err = new Error(
      `Error invoking remote method 'git:getBranches': Error: ${PREFIX}${JSON.stringify(payload)}`,
    );

    expect(toAppError(err)).toEqual(payload);
  });

  it('decodes a bare prefixed Error and defaults missing details to {}', () => {
    const err = new Error(`${PREFIX}${JSON.stringify({ code: 'X', message: 'y' })}`);

    expect(toAppError(err)).toEqual({ code: 'X', message: 'y', details: {} });
  });

  it('keeps code/details from an Error without a prefix', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'GIT_FAILED',
      details: { branch: 'main' },
    });

    expect(toAppError(err)).toEqual({ code: 'GIT_FAILED', message: 'boom', details: { branch: 'main' } });
  });

  it('defaults a bare Error to UNKNOWN', () => {
    expect(toAppError(new Error('boom'))).toEqual({ code: 'UNKNOWN', message: 'boom', details: {} });
  });

  it.each([
    ['number', 42, '42'],
    ['boolean', false, 'false'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('maps a %s primitive to UNKNOWN', (_label, input, expectedMessage) => {
    expect(toAppError(input)).toEqual({ code: 'UNKNOWN', message: expectedMessage, details: {} });
  });

  it('falls back to UNKNOWN and preserves the original message on malformed JSON', () => {
    const err = new Error(`${PREFIX}{not-json`);

    expect(toAppError(err)).toEqual({ code: 'UNKNOWN', message: err.message, details: {} });
  });

  it('falls back to UNKNOWN when the decoded payload is not shaped', () => {
    const err = new Error(`${PREFIX}${JSON.stringify({ foo: 'bar' })}`);

    expect(toAppError(err)).toEqual({ code: 'UNKNOWN', message: err.message, details: {} });
  });
});

describe('IpcBridge.invoke', () => {
  afterEach(clearBridge);

  it('normalizes a rejected plain-object error through toAppError', async () => {
    installBridge({
      getBranches: () => Promise.reject({ code: 'GIT_FAILED', message: 'boom' }),
    });
    const bridge = new IpcBridge();

    await expect(bridge.invoke('getBranches', { repoId: 'r1' })).rejects.toEqual({
      code: 'GIT_FAILED',
      message: 'boom',
      details: {},
    });
  });

  it('decodes a rejected Electron-wrapped Error', async () => {
    const payload = { code: 'REPO_NOT_FOUND', message: 'missing', details: {} };
    installBridge({
      getBranches: () =>
        Promise.reject(new Error(`Error invoking remote method 'git:getBranches': ${PREFIX}${JSON.stringify(payload)}`)),
    });
    const bridge = new IpcBridge();

    await expect(bridge.invoke('getBranches', { repoId: 'r1' })).rejects.toEqual(payload);
  });

  it('throws IPC_UNAVAILABLE synchronously when the bridge is absent', () => {
    clearBridge();
    const bridge = new IpcBridge();

    expect(() => bridge.invoke('getBranches', { repoId: 'r1' })).toThrow();
  });
});

describe('IpcBridge.onDeepLink', () => {
  afterEach(clearBridge);

  it('delegates to the preload bridge and returns its unsubscribe', () => {
    const unsubscribe = vi.fn();
    const onDeepLink = vi.fn((_cb: unknown) => unsubscribe);
    installBridge({ onDeepLink });
    const bridge = new IpcBridge();
    const cb = vi.fn();

    const off = bridge.onDeepLink(cb);

    expect(onDeepLink).toHaveBeenCalledWith(cb);
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('returns a no-op unsubscribe when the bridge is absent', () => {
    clearBridge();
    const bridge = new IpcBridge();

    expect(() => bridge.onDeepLink(() => {})()).not.toThrow();
  });
});

describe('IpcBridge.signalDeepLinkReady', () => {
  afterEach(clearBridge);

  it('forwards the readiness ack to the preload bridge', () => {
    const signalDeepLinkReady = vi.fn();
    installBridge({ signalDeepLinkReady });
    const bridge = new IpcBridge();

    bridge.signalDeepLinkReady();

    expect(signalDeepLinkReady).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the bridge or the method is absent', () => {
    clearBridge();
    const bridge = new IpcBridge();
    expect(() => bridge.signalDeepLinkReady()).not.toThrow();

    installBridge({});
    expect(() => bridge.signalDeepLinkReady()).not.toThrow();
  });
});
