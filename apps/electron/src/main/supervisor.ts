import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { app } from 'electron';
import {
  AUTH_CHANNELS,
  CHANNEL_TO_RPC,
  isStreamingRpc,
  type ChannelName,
} from '../ipc/channels';
import type { FsChangedPayload, ProgressPayload } from '../ipc/events';
import {
  GoCoreClient,
  type FsChangedEvent,
  type StreamHandle,
} from './go-core-client';

/**
 * Supervisor — spawns go-core, awaits GO_CORE_READY, heartbeats Ping 5s,
 * exponential backoff restart, queue drain (ipc-strategy.md §2.6, ADR-007).
 */

export interface SupervisorOptions {
  goCoreBinary: string;
  grpcAddr: string;
  httpAddr: string;
  dbPath?: string;
  /**
   * Explicit auth-token override. Omit in production: go-core generates a
   * 32-byte hex token in `--headless` mode and prints it on the GO_CORE_READY
   * line, which `awaitReady()` adopts as authoritative. Only a caller-supplied
   * override is forwarded via `--token` (see `spawn()`).
   */
  token?: string;
  /**
   * Directory containing libs/contracts/proto (gitcore.proto + imports).
   * Injected by main.ts; required whenever go-core is really spawned.
   */
  protoDir?: string;
  /** Explicit opt-in mock mode (also `MOCK_GO_CORE=1`). Never the default. */
  mock?: boolean;
  /**
   * Progress sink for server-streaming GitCore RPCs (Fetch/Pull/Push).
   *
   * Chosen approach (b) from the slice task: the supervisor stays window- and
   * Electron-free; `main.ts` injects a callback that forwards each
   * `ProgressPayload` to the single main window via `events.sendProgress`
   * (which emits on the `git:progress` channel). Tests inject a spy instead.
   */
  onProgress?: (payload: ProgressPayload) => void;
  /**
   * Filesystem-change sink for the background `Watch` stream.
   *
   * Same shape as `onProgress`: the supervisor stays window- and Electron-free;
   * `main.ts` injects a callback that forwards each `FsChangedPayload` to the
   * single main window via `events.sendFsChanged` (channel `fs:changed`).
   * Tests inject a spy instead.
   */
  onFsChanged?: (payload: FsChangedPayload) => void;
}

interface PendingRequest {
  channel: string;
  payload: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface ReadyInfo {
  addr: string;
  http: string;
  token: string;
}

export class Supervisor {
  private proc: ChildProcess | null = null;
  private ready = false;
  private token = '';
  private grpcAddr = '';
  private httpAddr = '';
  private restarts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Pending restart-chain timer; non-null means a restart is already queued. */
  private restartTimer: NodeJS.Timeout | null = null;
  private queue: PendingRequest[] = [];
  private readonly maxQueue = 100;
  private readonly mockMode: boolean;
  private client: GoCoreClient | null = null;
  /** Second client bound to `singularitree.v1.Auth` (same addr/token). */
  private authClient: GoCoreClient | null = null;
  /** Live background `Watch` stream; null when no repo is being watched. */
  private watchCall: StreamHandle | null = null;
  /**
   * Last repo whose `Watch` stream was requested. Survives child loss so the
   * watch can be re-established automatically after a go-core restart (W1);
   * cleared only by `stop()`.
   */
  private watchedRepoId: string | null = null;
  private readonly protoDir?: string;
  private readonly tokenOverride?: string;

  constructor(private readonly opts: SupervisorOptions) {
    // Token ownership lives in go-core. In `--headless` it generates a random
    // 32-byte hex token and prints it on GO_CORE_READY; `awaitReady()` adopts
    // that value. We deliberately do NOT generate a secret here and do NOT put
    // one on argv by default — argv is observable (e.g. `ps`). An explicit
    // `opts.token` remains supported as an opt-in override.
    this.tokenOverride = opts.token;
    this.token = opts.token ?? '';
    this.grpcAddr = opts.grpcAddr;
    this.httpAddr = opts.httpAddr;
    this.protoDir = opts.protoDir;
    // Mock only on explicit opt-in — never a silent default.
    this.mockMode = opts.mock ?? process.env['MOCK_GO_CORE'] === '1';
  }

  async start(): Promise<void> {
    if (this.mockMode) {
      console.log('[supervisor] mock mode (explicit opt-in) — skipping go-core spawn');
      this.ready = true;
      this.drainQueue();
      this.startHeartbeat();
      return;
    }
    await this.spawn();
    this.startHeartbeat();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.ready = false;
    this.stopWatch();
    // Explicit shutdown: forget the watched repo so no reconnect re-opens it (W1).
    this.watchedRepoId = null;
    this.client?.close();
    this.client = null;
    this.authClient?.close();
    this.authClient = null;
    // Null before kill so the child's `exit` handler does not schedule a restart.
    const child = this.proc;
    this.proc = null;
    child?.kill();
  }

  private async spawn(): Promise<void> {
    const args = [
      '--headless',
      '--grpc-addr',
      this.opts.grpcAddr,
      '--http-fallback-addr',
      this.opts.httpAddr,
    ];
    // Only an explicit override is passed on argv; by default go-core generates
    // the token itself and reports it back in GO_CORE_READY.
    if (this.tokenOverride) args.push('--token', this.tokenOverride);
    if (this.opts.dbPath) args.push('--db', this.opts.dbPath);

    // Resolve binary — in dev, fall back to `go run` if binary not present.
    const bin = this.opts.goCoreBinary;
    const useGoRun = !fs.existsSync(bin);
    const repoRoot = path.join(app.getAppPath(), '../..');

    const child = useGoRun
      ? spawn('go', ['run', './apps/go-core/cmd/go-core', ...args], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc = child;
    // Attach lifecycle handlers BEFORE awaiting readiness: a child that dies
    // during startup must be observed and restarted, not merely time out.
    this.attachChildLifecycle(child);

    try {
      await this.awaitReady(child);
    } catch (err) {
      console.error('[supervisor] go-core failed to become ready', err);
      if (this.proc === child) this.proc = null;
      child.kill();
      // Route startup failure into the same single restart chain.
      this.handleChildLoss('readiness failure');
      throw err;
    }
  }

  /** Observe child loss (exit/spawn error) from spawn time onward. */
  private attachChildLifecycle(child: ChildProcess): void {
    child.on('exit', (code, signal) => {
      // Ignore stale children superseded by stop()/restart.
      if (this.proc !== child) return;
      this.proc = null;
      this.handleChildLoss(`exit code=${code} signal=${signal}`);
    });
    child.on('error', (err) => {
      if (this.proc !== child) return;
      this.proc = null;
      this.handleChildLoss(`spawn error: ${String(err)}`);
    });
  }

  /** Shared child-loss path: tear down client state and queue exactly one restart. */
  private handleChildLoss(reason: string): void {
    this.ready = false;
    this.stopWatch();
    this.client?.close();
    this.client = null;
    this.authClient?.close();
    this.authClient = null;
    console.warn(`[supervisor] go-core lost (${reason}) — scheduling restart`);
    this.scheduleRestart();
  }

  private awaitReady(child: ChildProcess): Promise<ReadyInfo> {
    return new Promise<ReadyInfo>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onStderr);
        child.off('exit', onExit);
      };
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onData = (chunk: Buffer): void => {
        const line = chunk.toString();
        process.stdout.write(`[go-core] ${line}`);
        const m = line.match(/GO_CORE_READY\s+addr=(\S+)\s+http=(\S+)\s+token=(\S+)/);
        if (m) {
          this.grpcAddr = m[1];
          this.httpAddr = m[2];
          // stdout is authoritative for the token (go-core generates it).
          this.token = m[3];
          this.connectClient();
          this.ready = true;
          this.restarts = 0;
          // W1: if a repo was being watched before this (re)connect, re-open its
          // Watch stream now that the client is connected again.
          this.reestablishWatch();
          finish(() => {
            this.drainQueue();
            resolve({ addr: this.grpcAddr, http: this.httpAddr, token: this.token });
          });
        }
      };
      const onStderr = (c: Buffer): void => {
        process.stderr.write(`[go-core:err] ${c.toString()}`);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(() =>
          reject(
            new Error(
              `go-core exited before GO_CORE_READY (code=${code} signal=${signal})`,
            ),
          ),
        );

      timeout = setTimeout(
        () => finish(() => reject(new Error('GO_CORE_READY timeout'))),
        15000,
      );
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onStderr);
      child.on('exit', onExit);
    });
  }

  /** Build/replace the gRPC clients for the freshly parsed addr + token. */
  private connectClient(): void {
    if (!this.protoDir) {
      console.error('[supervisor] protoDir not configured — cannot create gRPC client');
      return;
    }
    if (!this.client) {
      this.client = new GoCoreClient({ protoDir: this.protoDir, serviceName: 'GitCore' });
    }
    this.client.connect(this.grpcAddr, this.token);
    // Auth is a distinct service on the same go-core process/addr/token; it needs
    // its own channel-bound client and must follow the identical reconnect path.
    if (!this.authClient) {
      this.authClient = new GoCoreClient({ protoDir: this.protoDir, serviceName: 'Auth' });
    }
    this.authClient.connect(this.grpcAddr, this.token);
  }

  private scheduleRestart(): void {
    // Re-entrancy guard: `error`+`exit` (or heartbeat vs exit) must not start
    // two concurrent restart chains (which would spawn two go-core processes).
    if (this.restartTimer) return;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const backoffs = [200, 500, 1000, 2000, 5000];
    const delay = backoffs[Math.min(this.restarts, backoffs.length - 1)];
    this.restarts += 1;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // Clear before re-spawning so a stale child's exit cannot be misread.
      this.proc = null;
      void this.spawn().then(
        () => this.startHeartbeat(),
        (e) => {
          console.error('[supervisor] restart failed', e);
          this.scheduleRestart();
        },
      );
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      void this.ping().catch(() => {
        console.warn('[supervisor] Ping missed — restarting go-core');
        this.proc?.kill();
        // exit may fire asynchronously; the guard collapses both into one chain.
        this.handleChildLoss('ping missed');
      });
    }, 5000);
  }

  /** Real gRPC `Ping` with Bearer metadata (mock mode is always healthy). */
  private async ping(): Promise<void> {
    if (this.mockMode) return;
    if (!this.ready || !this.client) throw new Error('go-core not ready');
    await this.client.ping();
  }

  private drainQueue(): void {
    const pending = [...this.queue];
    this.queue = [];
    for (const req of pending) {
      this.forwardToGo(req.channel, req.payload).then(req.resolve, req.reject);
    }
  }

  async forwardToGo(channel: string, payload: unknown): Promise<unknown> {
    const rpc = CHANNEL_TO_RPC[channel as ChannelName] as string | undefined;
    if (!rpc) {
      throw { code: 'UNKNOWN_CHANNEL', message: `No gRPC mapping for channel ${channel}` };
    }
    // Queue (do not reject) while go-core is starting — streaming requests too,
    // so a fetch/pull/push issued during startup still runs on GO_CORE_READY.
    if (!this.ready) {
      if (this.queue.length >= this.maxQueue) {
        throw { code: 'QUEUE_FULL', message: 'Go core unavailable and queue full' };
      }
      return new Promise((resolve, reject) => {
        this.queue.push({ channel, payload, resolve, reject });
      });
    }
    if (this.mockMode) {
      console.log(`[supervisor:mock] forward ${channel}`, payload);
      return { ok: true, channel, payload, mock: true };
    }
    // Watch is a background (never-ending) server-stream: start it and resolve
    // the ack immediately instead of awaiting the stream like Fetch/Pull/Push.
    // Queue-while-not-ready already applied above, so the ack settles once the
    // stream is actually running.
    if (rpc === 'Watch') {
      const repoId =
        typeof payload === 'object' && payload !== null
          ? (payload as { repoId?: unknown }).repoId
          : undefined;
      // `startWatch` validates repoId (W2): a missing/non-string/empty value is
      // rejected with INVALID_ARGUMENT rather than acked optimistically.
      return this.startWatch(repoId);
    }
    // Fetch/Pull/Push are short-lived server-streaming RPCs: drive the real
    // gRPC stream so progress reaches the renderer and the promise settles at
    // EOF/error.
    if (isStreamingRpc(rpc)) {
      return this.forwardStream(rpc, payload);
    }
    // Auth channels bind to the Auth client; everything else stays on GitCore.
    const target = AUTH_CHANNELS.has(channel) ? this.authClient : this.client;
    if (!target) {
      throw { code: 'GO_CORE_UNAVAILABLE', message: 'Go core gRPC client not connected' };
    }
    return target.invoke(rpc, payload);
  }

  /**
   * Drive a server-streaming GitCore RPC (Fetch/Pull/Push). Each `Progress`
   * message is forwarded to the injected `onProgress` sink (wired in main.ts to
   * `events.sendProgress`); the promise resolves at stream EOF and rejects on
   * stream error, so the renderer's `Promise<void>` contract holds.
   */
  private async forwardStream(rpc: string, payload: unknown): Promise<void> {
    // Streaming channels are all GitCore (never Auth).
    const target = this.client;
    if (!target) {
      throw { code: 'GO_CORE_UNAVAILABLE', message: 'Go core gRPC client not connected' };
    }
    const op = rpc.toLowerCase();
    await target.invokeStream(rpc, payload, (p) => {
      this.opts.onProgress?.({ op, percent: p.percent, message: p.message });
    });
  }

  /**
   * Start the background `Watch` stream for `repoId` and forward every
   * `FsChangedEvent` to the injected `onFsChanged` sink.
   *
   * Replace-any-existing semantics: a new `git:watch` cancels the previous
   * stream (a repo switch watches one repo at a time). The returned promise is
   * the IPC ack — it resolves as soon as the stream is running and never awaits
   * the never-ending stream, so the renderer's fire-and-forget invoke settles
   * promptly. A stream error that fires before the ack settles rejects it;
   * after that it only logs (the renderer is not waiting).
   */
  async startWatch(repoId: unknown): Promise<unknown> {
    // W2: reject a missing/non-string/empty repoId instead of opening a stream
    // with an empty repo and acking `{ok:true, watching:''}`.
    if (typeof repoId !== 'string' || repoId.length === 0) {
      throw {
        code: 'INVALID_ARGUMENT',
        message: 'git:watch requires a non-empty string repoId',
        details: {},
      };
    }
    this.stopWatch();
    const target = this.client;
    if (!target) {
      throw {
        code: 'GO_CORE_UNAVAILABLE',
        message: 'Go core gRPC client not connected',
        details: {},
      };
    }
    return new Promise<unknown>((resolve, reject) => {
      let pending = true;
      // `openStream` throws synchronously when not connected / unknown RPC; the
      // Promise executor turns that throw into a rejection automatically.
      const handle = target.openStream<FsChangedEvent>(
        'Watch',
        { repoId },
        (ev) => {
          // The core echoes repoId; fall back to the requested one defensively.
          this.opts.onFsChanged?.({
            repoId: ev.repoId || repoId,
            paths: ev.paths ?? [],
          });
        },
        (err) => {
          if (this.watchCall === handle) this.watchCall = null;
          if (pending) {
            pending = false;
            reject(err);
          } else {
            console.warn('[supervisor] Watch stream ended with error', err);
          }
        },
      );
      this.watchCall = handle;
      // Remember the repo so a go-core restart can re-open this stream (W1).
      this.watchedRepoId = repoId;
      pending = false;
      resolve({ ok: true, watching: repoId });
    });
  }

  /**
   * Re-open the last watched `Watch` stream after a (re)connect (W1). Called
   * from `awaitReady()` right after `connectClient()`; a no-op when nothing was
   * being watched. Failures are logged — the reconnect itself already succeeded.
   */
  private reestablishWatch(): void {
    const repoId = this.watchedRepoId;
    if (repoId === null) return;
    void this.startWatch(repoId).catch((err) => {
      console.warn('[supervisor] failed to re-establish watch after reconnect', err);
    });
  }

  /** Cancel the live `Watch` stream, if any. Also invoked by `stop()`/child loss. */
  stopWatch(): void {
    this.watchCall?.cancel();
    this.watchCall = null;
  }
}
