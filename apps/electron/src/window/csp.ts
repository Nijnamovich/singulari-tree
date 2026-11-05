/**
 * CSP strings — window/csp.ts (ipc-strategy.md §1.1).
 * Applied via session.defaultSession.webRequest or meta tag.
 * DEV_CSP relaxes for Angular ng serve on localhost:4200 (HMR ws, eval, inline).
 */
export const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' http://localhost:* ws://localhost:*; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:;";

export const DEV_CSP =
  "default-src 'self' http://localhost:*; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*; " +
  "style-src 'self' 'unsafe-inline' http://localhost:*; " +
  "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; " +
  "img-src 'self' data: http://localhost:*; " +
  "font-src 'self' data: http://localhost:*;";

export function getCsp(isDev: boolean): string {
  return isDev ? DEV_CSP : CSP;
}
