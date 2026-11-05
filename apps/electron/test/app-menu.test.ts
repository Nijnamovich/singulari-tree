import { beforeEach, describe, expect, it, vi } from 'vitest';

// app-menu.ts imports `electron`; stub the native surface so the module can be
// exercised under plain Node without an Electron runtime. `vi.mock` is hoisted,
// so the mock factories below are defined before the import.
const { buildFromTemplateMock, getFocusedWindowMock, getAllWindowsMock } = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn((template: unknown) => ({ template })),
  getFocusedWindowMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
}));

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: buildFromTemplateMock },
  BrowserWindow: {
    getFocusedWindow: getFocusedWindowMock,
    getAllWindows: getAllWindowsMock,
  },
}));

import type { MenuItemConstructorOptions } from 'electron';
import { MENU_CHANNELS } from '../src/ipc/channels';
import { buildAppMenu, buildAppMenuTemplate } from '../src/main/app-menu';

/**
 * Guards the native application menu: exactly one top-level `File` menu whose
 * submenu is `Git account`, `Repository options`, separator, `Exit` (native
 * `quit` role). The navigation entries must push `/github-account` and `/repos`
 * through the injected sink, and `buildAppMenu` must resolve the target window
 * lazily at click time (focused window, else the first one).
 */

type ClickHandler = () => void;

function submenuOf(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[];
}

function clickOf(item: MenuItemConstructorOptions): ClickHandler {
  return item.click as unknown as ClickHandler;
}

/** Builds the template and returns its sole `File` submenu. */
function fileSubmenu(sendNavigate: (route: string) => void): MenuItemConstructorOptions[] {
  const template = buildAppMenuTemplate(sendNavigate);
  expect(template).toHaveLength(1);
  expect(template[0]?.label).toBe('File');
  return submenuOf(template[0] as MenuItemConstructorOptions);
}

describe('buildAppMenuTemplate', () => {
  it('has a single top-level File menu', () => {
    const template = buildAppMenuTemplate(vi.fn());
    expect(template).toHaveLength(1);
    expect(template[0]?.label).toBe('File');
  });

  it('exposes exactly Git account, Repository options, separator, Exit', () => {
    const items = fileSubmenu(vi.fn());
    expect(items).toHaveLength(4);
    expect(items[0]?.label).toBe('Git account');
    expect(items[1]?.label).toBe('Repository options');
    expect(items[2]?.type).toBe('separator');
    expect(items[3]?.label).toBe('Exit');
    expect(items[3]?.role).toBe('quit');
  });

  it('navigates to /github-account on Git account', () => {
    const sendNavigate = vi.fn();
    clickOf(fileSubmenu(sendNavigate)[0] as MenuItemConstructorOptions)();
    expect(sendNavigate).toHaveBeenCalledWith('/github-account');
  });

  it('navigates to /repos on Repository options', () => {
    const sendNavigate = vi.fn();
    clickOf(fileSubmenu(sendNavigate)[1] as MenuItemConstructorOptions)();
    expect(sendNavigate).toHaveBeenCalledWith('/repos');
  });
});

describe('buildAppMenu', () => {
  beforeEach(() => {
    buildFromTemplateMock.mockClear();
    getFocusedWindowMock.mockReset();
    getAllWindowsMock.mockReset();
  });

  function builtTemplate(): MenuItemConstructorOptions[] {
    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1);
    return buildFromTemplateMock.mock.calls[0]?.[0] as MenuItemConstructorOptions[];
  }

  it('builds the template into a Menu', () => {
    buildAppMenu();
    const template = builtTemplate();
    expect(template).toHaveLength(1);
    expect(template[0]?.label).toBe('File');
  });

  it('sends menu:navigate to the focused window at click time', () => {
    const send = vi.fn();
    const focused = { webContents: { send } };
    getFocusedWindowMock.mockReturnValue(focused);
    getAllWindowsMock.mockReturnValue([focused]);

    buildAppMenu();
    clickOf(submenuOf(builtTemplate()[0] as MenuItemConstructorOptions)[0] as MenuItemConstructorOptions)();

    expect(send).toHaveBeenCalledWith(MENU_CHANNELS.navigate, { route: '/github-account' });
  });

  it('falls back to the first window when none is focused', () => {
    const send = vi.fn();
    const fallback = { webContents: { send } };
    getFocusedWindowMock.mockReturnValue(null);
    getAllWindowsMock.mockReturnValue([fallback]);

    buildAppMenu();
    clickOf(submenuOf(builtTemplate()[0] as MenuItemConstructorOptions)[1] as MenuItemConstructorOptions)();

    expect(send).toHaveBeenCalledWith(MENU_CHANNELS.navigate, { route: '/repos' });
  });

  it('does nothing when there is no window to navigate', () => {
    getFocusedWindowMock.mockReturnValue(null);
    getAllWindowsMock.mockReturnValue([]);

    buildAppMenu();
    const items = submenuOf(builtTemplate()[0] as MenuItemConstructorOptions);

    expect(() => clickOf(items[0] as MenuItemConstructorOptions)()).not.toThrow();
  });
});
