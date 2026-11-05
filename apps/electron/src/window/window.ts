import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { getCsp } from './csp';

/**
 * Brand icon for the window and Windows/Linux taskbar. `build/` is
 * electron-builder's buildResources directory, so it is NOT part of the asar
 * bundle: a packaged build receives it through `extraResources`, while a dev
 * run resolves it from the package root (app.getAppPath() === apps/electron).
 */
function resolveWindowIcon(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');
}

export function createMainWindow(): BrowserWindow {
  const isDev = Boolean(process.env['VITE_DEV_SERVER_URL'] ?? process.env['ELECTRON_START_URL']);
  const csp = getCsp(isDev);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // Matches the renderer's dark canvas (`--st-color-bg`, design-system.md), so
    // the pre-paint/load backdrop is the same navy and there is no colour flash.
    // The shell cannot read CSS custom properties, so the value is a literal and
    // must be updated with the token.
    backgroundColor: '#1e1e2e',
    // Brand glyph: without this the shell and its taskbar entry fall back to
    // Electron's generic icon.
    icon: resolveWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

  // CSP enforcement — header injection; relaxed for localhost in dev.
  // If the response already carries a CSP (e.g. `app://` responses set it in
  // main/protocol.ts), keep it rather than appending a second, invalid policy.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const existing = Object.keys(details.responseHeaders ?? {}).some(
      (k) => k.toLowerCase() === 'content-security-policy',
    );
    const responseHeaders = existing
      ? details.responseHeaders
      : { ...details.responseHeaders, 'Content-Security-Policy': [csp] };
    callback({ responseHeaders });
  });

  win.once('ready-to-show', () => win.show());

  return win;
}
