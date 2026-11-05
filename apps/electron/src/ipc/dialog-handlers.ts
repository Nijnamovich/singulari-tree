import { BrowserWindow, dialog, ipcMain } from 'electron';
import { DIALOG_CHANNELS } from './channels';
import { encodeIpcError } from './app-error';

/**
 * Registers ipcMain.handle for local (non-gRPC) dialog channels.
 *
 * These handlers run entirely in Electron main — they are NEVER forwarded to
 * the Go core. Failures are normalized with `encodeIpcError` (mirroring
 * `handlers.ts`) so a thrown value reaches the renderer as a decodable
 * `AppError` rather than `[object Object]`.
 */

/** Renderer-facing payload for `DIALOG_CHANNELS.chooseDirectory`. */
export interface ChooseDirectoryResponse {
  /** True when the user dismissed the dialog. */
  canceled: boolean;
  /** Selected directory; `''` when canceled. */
  path: string;
}

export function registerDialogHandlers(): void {
  ipcMain.handle(
    DIALOG_CHANNELS.chooseDirectory,
    async (): Promise<ChooseDirectoryResponse> => {
      try {
        const parentWindow = BrowserWindow.getFocusedWindow() ?? undefined;
        // Electron's overloads: pass the parent window when one exists, else
        // fall back to the no-parent overload. `dialog.showOpenDialog` may
        // return a promise (when no callback is supplied) or the result object
        // (legacy sync path); awaiting handles the promise form.
        const res = parentWindow
          ? await dialog.showOpenDialog(parentWindow, { properties: ['openDirectory'] })
          : await dialog.showOpenDialog({ properties: ['openDirectory'] });
        return {
          canceled: res.canceled,
          path: res.filePaths[0] ?? '',
        };
      } catch (err) {
        throw encodeIpcError(err);
      }
    },
  );
}

export function unregisterDialogHandlers(): void {
  ipcMain.removeHandler(DIALOG_CHANNELS.chooseDirectory);
}
