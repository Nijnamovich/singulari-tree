import { app, net, protocol } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CSP } from '../window/csp';

/**
 * Privileged `app://` scheme for loading the packaged Angular renderer.
 *
 * The shell serves the built SPA through a custom protocol instead of
 * `file://`/`loadFile` so that a `standard`, `secure` origin exists in production.
 * A standard origin is required for Angular's router/history and for `'self'`
 * CSP directives to behave the same as over http.
 */

/** Explicit MIME map so assets are not served as `application/octet-stream`. */
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Must run at module top level in `main.ts`, BEFORE `app.whenReady()` —
 * `registerSchemesAsPrivileged` has no effect once the app is ready.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Absolute root directory holding the built renderer (`index.html` + chunks). */
function rendererRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'renderer');
  }
  return path.join(app.getAppPath(), '..', 'angular', 'dist', 'browser');
}

/**
 * Map a request pathname onto a file inside `root`, falling back to
 * `index.html` for SPA routes, missing files and path-traversal attempts.
 */
function resolveRequestFile(root: string, pathname: string): string {
  const indexHtml = path.join(root, 'index.html');
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return indexHtml;
  }

  const candidate = path.normalize(path.join(root, decoded));
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return indexHtml;
  }

  try {
    if (fs.statSync(candidate).isDirectory()) {
      return indexHtml;
    }
  } catch {
    return indexHtml;
  }
  return candidate;
}

/**
 * Register the `app://` handler. Call AFTER `app.whenReady()`.
 * `app://bundle/index.html` serves the packaged renderer root.
 */
export function registerAppProtocol(): void {
  const root = rendererRoot();

  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const file = resolveRequestFile(root, pathname);

    const response = await net.fetch(pathToFileURL(file).toString());

    const headers = new Headers(response.headers);
    const contentType = MIME[path.extname(file).toLowerCase()];
    if (contentType) {
      // Override the OS MIME registry (often octet-stream for .js/.woff2).
      headers.set('Content-Type', contentType);
    }

    // `session.webRequest.onHeadersReceived` (window/csp.ts wiring) may or may not
    // intercept responses produced by `protocol.handle`; if it does, it appends a
    // second CSP. Set the CSP here (single source of truth for `app://`) after
    // removing any pre-existing case-variant key, so exactly one policy ships.
    for (const key of [...headers.keys()]) {
      if (key.toLowerCase() === 'content-security-policy') headers.delete(key);
    }
    headers.set('Content-Security-Policy', CSP);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}
