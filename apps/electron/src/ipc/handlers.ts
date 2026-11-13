import { ipcMain } from 'electron';
import { CHANNELS, validate, type ChannelName } from './channels';
import { encodeIpcError, isSilentCancellation } from './app-error';

/**
 * Registers ipcMain.handle for each channel — validate + forward to Go core.
 * forwardToGo is injected by main.ts / supervisor.ts.
 *
 * Every failure is normalized with `encodeIpcError` so a plain-object `AppError`
 * never reaches Electron's serializer (which would stringify it to
 * `[object Object]`). The renderer recovers the payload via `decodeIpcError`.
 *
 * Exception: a cancellation the shell itself caused while tearing the channel
 * down (see `markSilentCancellation`) resolves empty. Electron logs every throw
 * from a handler at error level, so rethrowing there would report a deliberate
 * shutdown as a product failure.
 */

export type ForwardToGo = (channel: ChannelName, payload: unknown) => Promise<unknown>;

export function registerIpcHandlers(forwardToGo: ForwardToGo): void {
  for (const channel of Object.values(CHANNELS) as ChannelName[]) {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      try {
        validate(channel, payload);
      } catch (err) {
        throw encodeIpcError({
          code: 'INVALID_ARGUMENT',
          message: err instanceof Error ? err.message : String(err),
          details: {},
        });
      }
      try {
        return await forwardToGo(channel, payload);
      } catch (err) {
        if (isSilentCancellation(err)) return undefined;
        throw encodeIpcError(err);
      }
    });
  }
}

export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(CHANNELS) as ChannelName[]) {
    ipcMain.removeHandler(channel);
  }
}
