/**
 * Error normalization at the Electron IPC boundary (main side).
 *
 * Plain-object `AppError`s cross `ipcMain.handle` unnormalized and Electron's
 * serializer collapses them to `[object Object]`. Every thrown value is turned
 * into a real `Error` whose message carries {@link APP_ERROR_PREFIX} followed by
 * the JSON payload, which the renderer decodes on the other side.
 *
 * Contract is frozen: the renderer coder codes against this exact shape.
 */

/** Renderer-facing error envelope. Mirrors `errors.proto` `AppError`. */
export interface AppErrorPayload {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** Stable prefix so the renderer can recover the payload from an Error.message. */
export const APP_ERROR_PREFIX = 'ST_APP_ERROR:';

/** True only for plain objects (not class instances such as `Error` or arrays). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** `String()` that never throws (guards against hostile `toString`). */
function stringifySafely(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Serialize a plain object without leaking unrelated fields (e.g. a stray
 * `token`). Only the whitelisted error surface is included.
 */
function safeJsonStringify(err: Record<string, unknown>): string {
  try {
    const sanitized: Record<string, unknown> = {};
    if (typeof err.code === 'string') sanitized.code = err.code;
    if (isPlainObject(err.details)) sanitized.details = err.details;
    const json = JSON.stringify(sanitized);
    return json !== undefined && json !== '{}' ? json : 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

/** Drop-in guard for already-shaped payloads. */
export function isAppErrorPayload(v: unknown): v is AppErrorPayload {
  return (
    isPlainObject(v) &&
    typeof v.code === 'string' &&
    typeof v.message === 'string'
  );
}

/** Normalize ANY thrown value into a real payload. */
export function normalizeAppError(err: unknown): AppErrorPayload {
  // Already-shaped payload: keep code/message, ensure details is an object.
  if (isAppErrorPayload(err)) {
    return {
      code: err.code,
      message: err.message,
      details: isPlainObject(err.details) ? err.details : {},
    };
  }

  // Error instance (including class instances carrying `code`/`details`).
  if (err instanceof Error) {
    const coded = err as unknown as { code?: unknown; details?: unknown };
    return {
      code: typeof coded.code === 'string' ? coded.code : 'INTERNAL',
      message: err.message || stringifySafely(err),
      details: isPlainObject(coded.details) ? coded.details : {},
    };
  }

  // Plain object: whitelist known fields only, drop everything else.
  if (isPlainObject(err)) {
    const code = typeof err.code === 'string' ? err.code : 'UNKNOWN';
    const message =
      typeof err.message === 'string' ? err.message : safeJsonStringify(err);
    const details = isPlainObject(err.details) ? err.details : {};
    return { code, message, details };
  }

  // String primitive.
  if (typeof err === 'string') {
    return { code: 'UNKNOWN', message: err, details: {} };
  }

  // undefined / null / number / boolean / symbol / bigint / function.
  return { code: 'UNKNOWN', message: stringifySafely(err), details: {} };
}

/**
 * Build a real Error whose message is {@link APP_ERROR_PREFIX} +
 * `JSON.stringify(payload)`. Sets `err.name = 'AppError'`.
 *
 * Never loses `code`/`message`/`details` (a non-serializable `details` falls
 * back to `{}` rather than dropping the whole envelope) and never includes any
 * request payload.
 */
export function encodeIpcError(err: unknown): Error {
  const payload = normalizeAppError(err);
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    // Details not JSON-serializable (e.g. circular): keep code/message.
    serialized = JSON.stringify({ ...payload, details: {} });
  }
  const error = new Error(APP_ERROR_PREFIX + serialized);
  error.name = 'AppError';
  return error;
}

/**
 * Recover the payload from an Error (searching the prefix anywhere in the
 * message, since Electron prepends `Error invoking remote method ...`), a plain
 * object, or a primitive. Never throws; falls back to
 * `{code:'UNKNOWN', message:String(err), details:{}}`.
 */
export function decodeIpcError(err: unknown): AppErrorPayload {
  try {
    const rawMessage =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : undefined;

    if (rawMessage !== undefined) {
      const idx = rawMessage.indexOf(APP_ERROR_PREFIX);
      if (idx !== -1) {
        const json = rawMessage.slice(idx + APP_ERROR_PREFIX.length);
        const parsed: unknown = JSON.parse(json);
        if (isAppErrorPayload(parsed)) {
          return {
            code: parsed.code,
            message: parsed.message,
            details: isPlainObject(parsed.details) ? parsed.details : {},
          };
        }
      }
    }

    if (isAppErrorPayload(err)) {
      return {
        code: err.code,
        message: err.message,
        details: isPlainObject(err.details) ? err.details : {},
      };
    }

    return normalizeAppError(err);
  } catch {
    return { code: 'UNKNOWN', message: stringifySafely(err), details: {} };
  }
}
