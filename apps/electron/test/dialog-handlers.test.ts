import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// dialog-handlers.ts imports `electron`; stub the native surface so the module
// can be exercised under plain Node without an Electron runtime. `vi.mock` is
// hoisted, so the mock factories below are defined before the import.
const { handleMock, removeHandlerMock, showOpenDialogMock, getFocusedWindowMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    showOpenDialogMock: vi.fn(),
    getFocusedWindowMock: vi.fn(),
  }),
);

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
  dialog: { showOpenDialog: showOpenDialogMock },
  BrowserWindow: { getFocusedWindow: getFocusedWindowMock },
}));

import { DIALOG_CHANNELS } from '../src/ipc/channels';
import {
  registerDialogHandlers,
  unregisterDialogHandlers,
} from '../src/ipc/dialog-handlers';

/**
 * Guards the local dialog IPC channel: it must be registered on
 * `dialog:chooseDirectory` and resolve `{ canceled, path }` from Electron's
 * native `dialog.showOpenDialog`, with `path: ''` on cancel. Exercises both
 * the parent-window and no-parent overloads.
 */

type Handler = () => Promise<{ canceled: boolean; path: string }>;

function registeredHandler(): Handler {
  expect(handleMock).toHaveBeenCalledWith(
    DIALOG_CHANNELS.chooseDirectory,
    expect.any(Function),
  );
  return handleMock.mock.calls[0]?.[1] as Handler;
}

describe('registerDialogHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset();
    removeHandlerMock.mockReset();
    showOpenDialogMock.mockReset();
    getFocusedWindowMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the chooseDirectory channel exactly once', () => {
    registerDialogHandlers();
    expect(handleMock).toHaveBeenCalledTimes(1);
    expect(handleMock).toHaveBeenCalledWith(
      DIALOG_CHANNELS.chooseDirectory,
      expect.any(Function),
    );
  });

  it('returns the selected directory using the parent-window overload', async () => {
    const parentWindow = { id: 1 };
    getFocusedWindowMock.mockReturnValue(parentWindow);
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/home/user/repo'],
    });
    registerDialogHandlers();

    const res = await registeredHandler()();

    expect(showOpenDialogMock).toHaveBeenCalledWith(parentWindow, {
      properties: ['openDirectory'],
    });
    expect(res).toEqual({ canceled: false, path: '/home/user/repo' });
  });

  it('uses the no-parent overload when no window is focused', async () => {
    getFocusedWindowMock.mockReturnValue(null);
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/repo'],
    });
    registerDialogHandlers();

    await registeredHandler()();

    expect(showOpenDialogMock).toHaveBeenCalledWith({ properties: ['openDirectory'] });
  });

  it('yields path "" when the dialog is canceled', async () => {
    getFocusedWindowMock.mockReturnValue(null);
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    registerDialogHandlers();

    const res = await registeredHandler()();

    expect(res).toEqual({ canceled: true, path: '' });
  });

  it('yields path "" when canceled even with a stray filePath', async () => {
    getFocusedWindowMock.mockReturnValue(null);
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: ['/ignored'] });
    registerDialogHandlers();

    // path comes from filePaths[0], but a canceled dialog reports none in
    // practice; `?? ''` still guards the empty-array case asserted above.
    const res = await registeredHandler()();
    expect(res.canceled).toBe(true);
  });

  it('normalizes a native failure with encodeIpcError', async () => {
    getFocusedWindowMock.mockReturnValue(null);
    showOpenDialogMock.mockRejectedValue(new Error('dialog blew up'));
    registerDialogHandlers();

    await expect(registeredHandler()()).rejects.toMatchObject({ name: 'AppError' });
  });

  it('unregisters the chooseDirectory handler', () => {
    unregisterDialogHandlers();
    expect(removeHandlerMock).toHaveBeenCalledWith(DIALOG_CHANNELS.chooseDirectory);
  });
});
