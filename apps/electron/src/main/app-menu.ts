import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { MENU_CHANNELS } from '../ipc/channels';

/**
 * Builds the native application menu template.
 *
 * Pure: the navigation sink is injected so click handlers can be unit-tested
 * without an Electron runtime. The OS-native menu is the ONLY top menu — its
 * `File` entry contains exactly `Git account`, `Repository options`, `Exit`.
 */
export function buildAppMenuTemplate(
  sendNavigate: (route: string) => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: 'File',
      submenu: [
        { label: 'Git account', click: () => sendNavigate('/github-account') },
        { label: 'Repository options', click: () => sendNavigate('/repos') },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' },
      ],
    },
  ];
}

/**
 * Builds the application menu.
 *
 * `Menu.setApplicationMenu` runs before the first `BrowserWindow` exists, so the
 * target window cannot be captured now. Resolving it lazily at click time also
 * targets whichever window is focused when the menu item is activated.
 */
export function buildAppMenu(): Menu {
  const sendNavigate = (route: string): void => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.webContents.send(MENU_CHANNELS.navigate, { route });
  };

  return Menu.buildFromTemplate(buildAppMenuTemplate(sendNavigate));
}
