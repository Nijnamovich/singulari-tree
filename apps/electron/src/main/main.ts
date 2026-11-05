import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { createMainWindow } from '../window/window';
import { registerIpcHandlers } from '../ipc/handlers';
import { registerDialogHandlers, unregisterDialogHandlers } from '../ipc/dialog-handlers';
import { DEEP_LINK_READY_CHANNEL } from '../ipc/channels';
import { sendDeepLink, sendFsChanged, sendProgress } from '../ipc/events';
import { Supervisor } from './supervisor';
import { buildAppMenu } from './app-menu';
import { registerAppProtocol, registerPrivilegedSchemes } from './protocol';
import {
  DEEP_LINK_SCHEME,
  extractDeepLinkFromArgv,
  parseDeepLink,
  type DeepLink,
} from './deep-link';

// Must be called before app.whenReady() (module top level) so the privileged
// `app://` scheme is registered in time.
registerPrivilegedSchemes();

// Must match `appId` in electron-builder.yml: Windows uses the AppUserModelId
// to attribute the window/taskbar entry to SingulariTree instead of the generic
// Electron host.
app.setAppUserModelId('com.singularitree.app');

let mainWindow: BrowserWindow | null = null;
let supervisor: Supervisor | null = null;

/**
 * Deep links waiting for the renderer to acknowledge readiness (ADR-025). The OS
 * can hand us URLs before the first window/renderer exists, and the Angular
 * bootstrap may subscribe to `deeplink:open` *after* `did-finish-load`, so links
 * are held in a FIFO queue and drained in arrival order once the renderer acks.
 */
const pendingDeepLinks: DeepLink[] = [];
/** True once the renderer has acknowledged it subscribed to `deeplink:open`. */
let rendererReady = false;
/**
 * Bounded fallback timer: if the renderer never sends the readiness ack (e.g. an
 * older preload), assume readiness after this delay so a queued link is not held
 * forever. The ack is authoritative and cancels the timer.
 */
let rendererReadyFallback: ReturnType<typeof setTimeout> | null = null;

/** Bounded fallback window armed after `did-finish-load` (ms). */
const RENDERER_READY_FALLBACK_MS = 3000;

/** Parse + enqueue a raw deep-link URL; invalid links are ignored. */
function queueDeepLink(raw: string): void {
  const link = parseDeepLink(raw);
  if (!link) return;
  pendingDeepLinks.push(link);
  flushDeepLinks();
}

/** Drain the queued deep links in FIFO order once the renderer is ready. */
function flushDeepLinks(): void {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  const win = mainWindow;
  while (pendingDeepLinks.length > 0) {
    // The queue is append-only from event handlers, so shifting is safe.
    sendDeepLink(win, pendingDeepLinks.shift() as DeepLink);
  }
}

/**
 * Mark the renderer ready (idempotent) and drain the queue. Called by the
 * renderer's `deeplink:ready` ack, or by the bounded `did-finish-load` fallback.
 */
function markRendererReady(): void {
  rendererReady = true;
  if (rendererReadyFallback) {
    clearTimeout(rendererReadyFallback);
    rendererReadyFallback = null;
  }
  flushDeepLinks();
}

/** Arm the bounded fallback; a no-op once the renderer has already acked. */
function armRendererReadyFallback(): void {
  if (rendererReady) {
    flushDeepLinks();
    return;
  }
  if (rendererReadyFallback) clearTimeout(rendererReadyFallback);
  rendererReadyFallback = setTimeout(markRendererReady, RENDERER_READY_FALLBACK_MS);
}

/**
 * Prepare a freshly-created renderer window for deep-link delivery: reset the
 * readiness flag (a new renderer must re-ack) and arm the bounded fallback for
 * the case where the ack never arrives.
 */
function attachDeepLinkRenderer(win: BrowserWindow): void {
  rendererReady = false;
  win.webContents.on('did-finish-load', () => {
    // `did-finish-load` can fire before Angular's bootstrap subscribes, so it
    // only arms the fallback; the `deeplink:ready` ack is authoritative.
    armRendererReadyFallback();
  });
}

/** Restore + focus the main window in response to an external activation. */
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function getGoCoreBinary(): string {
  const exe = process.platform === 'win32' ? '.exe' : '';
  // In packaged app, go-core binary is alongside resources.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'go-core', 'go-core' + exe);
  }
  // Dev — look for built binary under SingulariTree/dist
  return path.join(app.getAppPath(), '../../dist/go-core' + exe);
}

/**
 * Directory holding the proto SSOT (libs/contracts/proto). The GoCoreClient
 * loads these with @grpc/proto-loader at runtime; proto files are bundled as
 * resources when packaged.
 */
function getProtoDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'proto');
  }
  return path.join(app.getAppPath(), '../../libs/contracts/proto');
}

/**
 * Wait until dev server responds (poll with http). Returns true if reachable within timeout.
 * Used to avoid Electron racing ahead of `ng serve`.
 */
async function waitForDevServer(url: string, timeoutMs = 30000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = lib.get(url, (res) => {
        // any 2xx/3xx means server is up (Angular may return 200 or 304)
        const up = (res.statusCode ?? 500) < 500;
        res.resume();
        resolve(up);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function loadWithRetry(win: BrowserWindow, url: string): Promise<void> {
  // First, poll server readiness before first loadURL
  const ready = await waitForDevServer(url, 30000, 700);
  if (!ready) {
    console.warn(`[main] dev server ${url} not reachable after 30s — attempting load anyway`);
  }
  let attempts = 0;
  const maxAttempts = 20;
  while (attempts < maxAttempts) {
    try {
      await win.loadURL(url);
      console.log(`[main] loaded ${url}`);
      return;
    } catch (e) {
      attempts += 1;
      console.warn(`[main] loadURL failed attempt ${attempts}/${maxAttempts}`, e);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error(`Failed to load ${url} after ${maxAttempts} attempts`);
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Register the provisional custom scheme as the OS default handler. Guarded
  // so dev/test is unaffected (packaged builds only); the scheme is reversible
  // per ADR-025.
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  // Windows/Linux initial launch: the deep link arrives as a process argument.
  const initialDeepLink = extractDeepLinkFromArgv(process.argv);
  if (initialDeepLink) queueDeepLink(initialDeepLink);

  // Serve the packaged renderer over the privileged `app://` origin.
  registerAppProtocol();

  Menu.setApplicationMenu(buildAppMenu());

  // The renderer's `deeplink:ready` ack is authoritative: it is sent from the
  // Angular bootstrap AFTER subscribing to `deeplink:open`, so draining on the
  // ack avoids the `did-finish-load` race. Register before the window exists.
  ipcMain.on(DEEP_LINK_READY_CHANNEL, () => markRendererReady());

  mainWindow = createMainWindow();
  // Arm the bounded `did-finish-load` fallback for any queued deep link.
  attachDeepLinkRenderer(mainWindow);

  const devUrl = process.env['VITE_DEV_SERVER_URL'] ?? process.env['ELECTRON_START_URL'];

  // Mock is strictly opt-in (MOCK_GO_CORE=1). Real go-core is the default so
  // IPC traffic always exercises the gRPC dispatch path.
  supervisor = new Supervisor({
    goCoreBinary: getGoCoreBinary(),
    grpcAddr: '127.0.0.1:0',
    httpAddr: '127.0.0.1:0',
    token: process.env['GO_CORE_TOKEN'],
    protoDir: getProtoDir(),
    mock: process.env['MOCK_GO_CORE'] === '1',
    // Fetch/Pull/Push progress → renderer `git:progress` event. Chosen approach
    // (b): the supervisor has no window reference; this injected sink owns it.
    onProgress: (payload) => {
      if (mainWindow) sendProgress(mainWindow, payload);
    },
    // Background `Watch` fs-change events → renderer `fs:changed` event. The
    // renderer reloads the graph/status/diff off this signal (git:watch starts
    // the stream; this sink pushes each event).
    onFsChanged: (payload) => {
      if (mainWindow) sendFsChanged(mainWindow, payload);
    },
  });

  // Fire-and-forget supervisor start; renderer will queue until GO_CORE_READY (mock resolves instantly)
  supervisor.start().catch((e) => console.error('[main] supervisor start failed', e));

  // Wire IPC handlers -> supervisor forwardToGo
  registerIpcHandlers((channel, payload) => {
    if (!supervisor) throw new Error('Supervisor not initialized');
    return supervisor.forwardToGo(channel, payload);
  });

  // Local (non-gRPC) channels — native Electron dialogs, never forwarded to Go.
  registerDialogHandlers();

  // Load renderer — dev branch exercised via loadURL
  if (devUrl) {
    // did-fail-load retry for race where ng serve restarts
    mainWindow.webContents.on('did-fail-load', (_ev, _code, _desc, validatedURL) => {
      if (validatedURL === devUrl) {
        console.warn(`[main] did-fail-load ${validatedURL} — retrying in 1s`);
        setTimeout(() => {
          mainWindow?.loadURL(devUrl).catch((e) => console.error('[main] retry loadURL failed', e));
        }, 1000);
      }
    });
    await loadWithRetry(mainWindow, devUrl);
    if (!app.isPackaged) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    // Production — Angular build output served through the `app://` protocol
    // (renderer root resolved inside protocol.ts for dev vs packaged).
    await mainWindow.loadURL('app://bundle/index.html');
  }

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    unregisterDialogHandlers();
    supervisor?.stop();
  });
}

// ADR-025: acquire the single-instance lock first so a second launch forwards
// its deep link to the running instance instead of opening a new window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const raw = extractDeepLinkFromArgv(argv);
    if (raw) queueDeepLink(raw);
    focusMainWindow();
  });

  bootstrap().catch((e) => {
    console.error('[main] bootstrap failed', e);
    app.quit();
  });
}
