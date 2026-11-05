# IPC strategy — Preload + gRPC/HTTP + Proto + Supervisor

## 1. Overview

Two channels:

```
Angular (renderer)  ──IPC (Electron)──▶  Electron main  ──gRPC/HTTP (localhost)──▶  Go core
  window.gitClientApi        ipcMain.handle         supervisor.forwardToGo       singularitree.v1
```

- **Angular ↔ Electron:** `contextIsolation` + `contextBridge` + `ipcRenderer.invoke/handle` + `ipcRenderer.on` events.
- **Electron ↔ Go:** gRPC primary on unix socket/named pipe + HTTP fallback on ephemeral `127.0.0.1:0`, both with `token` auth.

Go never talks directly to Angular; Electron never implements Git.

## 1.2 Preload bridge (single)

`apps/electron/src/preload/preload.ts` — **a single** `contextBridge.exposeInMainWorld` call.

```ts
// preload.ts
import { contextBridge, ipcRenderer } from 'electron';
export interface GitClientApi {
  getCommits: (req: unknown) => Promise<unknown>;
  getBranches: (req: unknown) => Promise<unknown>;
  getRemotes:  (req: unknown) => Promise<unknown>;
  getTags:     (req: unknown) => Promise<unknown>;
  getStashes:  (req: unknown) => Promise<unknown>;
  getStatus:   (req: unknown) => Promise<unknown>;
  getDiff:     (req: unknown) => Promise<unknown>;
  stage:       (req: unknown) => Promise<unknown>;
  unstage:     (req: unknown) => Promise<unknown>;
  commit:      (req: unknown) => Promise<unknown>;
  checkout:    (req: unknown) => Promise<unknown>;
  fetch: (req: unknown) => Promise<unknown>; // streaming progress via events
  pull:  (req: unknown) => Promise<unknown>;
  push:  (req: unknown) => Promise<unknown>;
  onRepoChanged: (cb:(p:unknown)=>void)=>()=>void;
  onFsChanged:   (cb:(p:unknown)=>void)=>()=>void;
  onProgress:    (cb:(p:unknown)=>void)=>()=>void;
}
const api: GitClientApi = {
  getCommits: (req)=> ipcRenderer.invoke('git:getCommits', req),
  getBranches:(req)=> ipcRenderer.invoke('git:getBranches', req),
  // ... 1:1 with CHANNELS
  onFsChanged: (cb)=> { const h=(_:unknown,p:unknown)=>cb(p); ipcRenderer.on('fs:changed',h as never); return ()=>ipcRenderer.removeAllListeners('fs:changed'); },
};
contextBridge.exposeInMainWorld('gitClientApi', api);
```

**Rules:**
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` in `BrowserWindow`.
- Never expose `ipcRenderer` directly or `require`.
- Validation in `ipc/channels.ts` (`validate(channel,payload)`) before forwarding.
- Angular consumes via `apps/angular/src/app/core/services/ipc-bridge.service.ts` (`IpcBridge` typed wrapper + `AppError`).

Types generated from proto (`libs/contracts/gen/ts`) replace `unknown` after `buf generate` (path alias `@contracts`).

## 2. Electron ↔ Go

### 2.1 Transport — Decision

| Criterion | gRPC (primary) | HTTP/JSON (fallback) |
|----------|----------------|----------------------|
| Streaming server | native (`stream Progress`, `Watch`) | SSE/long-poll (more fragile) |
| Typing | proto + buf lint/breaking | manual |
| Overhead | low (http/2) | medium |
| Unix socket/named pipe | yes | yes |
| Tooling | `grpc-go` + interceptors | `net/http` |

**Choice:** gRPC primary on unix socket (Linux/macOS) / named pipe (Windows) `unix:///tmp/singularitree-go.sock` or `\\.\pipe\singularitree-go-core`; HTTP fallback always up on `127.0.0.1:0` for `curl`/debug and if gRPC is unavailable. Both with token.

Current scaffold maps the unix socket to `127.0.0.1:0` TCP for cross-platform buildability; production implements real `net.Listen("unix", path)`.

### 2.2 Channels mapping

`apps/electron/src/ipc/channels.ts`:
```ts
export const CHANNELS = {
  getCommits: 'git:getCommits',
  getBranches:'git:getBranches',
  getRemotes: 'git:getRemotes',
  getTags:    'git:getTags',
  getStashes: 'git:getStashes',
  getStatus:  'git:getStatus',
  getDiff:    'git:getDiff',
  stage:      'git:stage',
  unstage:    'git:unstage',
  commit:     'git:commit',
  checkout:   'git:checkout',
  fetch:      'git:fetch',
  push:       'git:push',
  pull:       'git:pull',
} as const;
```

`handlers.ts`:
```ts
export function registerIpcHandlers(forwardToGo: ForwardToGo){
  for(const ch of Object.values(CHANNELS)){
    ipcMain.handle(ch, async (_e, payload)=>{ validate(ch,payload); return forwardToGo(ch,payload); });
  }
}
```

`supervisor.forwardToGo(channel,payload)` maps channel → proto RPC (switch), attaches `authorization: Bearer <token>` metadata, and dispatches gRPC or HTTP fallback if gRPC is `UNAVAILABLE`.

### 2.3 Proto sketch (singularitree.v1)

`libs/contracts/proto/*.proto` — `package singularitree.v1` (alias `gitclient.v1` in comments).

**domain.proto** (VOs/entities): `Oid`, `Signature`, `RefName`, `Commit`, `Branch`, `Remote`, `Tag`, `Stash`, `Worktree`, `Repository`, `Diff/Hunk/DiffLine`, `FileStatus`.

**errors.proto:** `message AppError{code,message,details}` + `enum ErrorCode` (wire uses `code string`).

**gitcore.proto** (service):
```proto
syntax="proto3";
package singularitree.v1;
import "domain.proto"; import "errors.proto";
option go_package = "github.com/SingulariTree/go-core/gen/go/singularitree/v1;singularitreev1";

service GitCore {
  rpc Ping(PingRequest) returns (PingResponse);
  rpc GetRepository(GetRepositoryRequest) returns (Repository);
  rpc ListRepositories(ListRepositoriesRequest) returns (ListRepositoriesResponse);
  rpc GetCommits(GetCommitsRequest) returns (GetCommitsResponse);
  rpc StreamCommits(StreamCommitsRequest) returns (stream Commit);
  rpc GetBranches(GetBranchesRequest) returns (GetBranchesResponse);
  rpc GetRemotes(GetRemotesRequest) returns (GetRemotesResponse);
  rpc GetTags(GetTagsRequest) returns (GetTagsResponse);
  rpc GetStashes(GetStashesRequest) returns (GetStashesResponse);
  rpc GetWorktrees(GetWorktreesRequest) returns (GetWorktreesResponse);
  rpc GetStatus(GetStatusRequest) returns (GetStatusResponse);
  rpc GetDiff(GetDiffRequest) returns (Diff);
  rpc Stage(StageRequest) returns (StageResponse);
  rpc Unstage(UnstageRequest) returns (UnstageResponse);
  rpc Commit(CommitRequest) returns (Commit);
  rpc Checkout(CheckoutRequest) returns (CheckoutResponse);
  rpc Fetch(FetchRequest) returns (stream Progress);
  rpc Push(PushRequest) returns (stream Progress);
  rpc Pull(PullRequest) returns (stream Progress);
  rpc Watch(WatchRequest) returns (stream FsChangedEvent);
}
message PingRequest {}  message PingResponse{ bool ok=1; uint64 uptime_ms=2; uint32 queue_depth=3; }
message Progress{ uint32 percent=1; string message=2; }
message FsChangedEvent{ string repo_id=1; repeated string paths=2; }
```

`buf.yaml` v2 + `buf.gen.yaml` generates `gen/go` (`go` + `grpc/go`) and `gen/ts` (`ts-proto`).

### 2.4 Authentication

- 32B hex token (64 chars) generated in Go if `--token` is not passed; supervisor generates and passes `--token <hex>` on spawn; Go prints it in `GO_CORE_READY token=...`.
- gRPC: `authorization: Bearer <token>` metadata; interceptor validates.
- HTTP: `X-Auth-Token` header or `Authorization: Bearer`.
- Bind loopback only (`127.0.0.1`/`unix socket`); never `0.0.0.0`.

### 2.5 Wire error handling

- Go: `AppError` → `status.Error(codes.Code, msg)` with `details` in `google.rpc.ErrorInfo` or trailing metadata `x-app-error-code`.
- Electron: intercepts, maps to `AppError` JSON for the renderer; `QUEUE_FULL` → retry/backoff in Angular.
- Angular: `IpcBridge` throws `AppError{code,message,details}`; stores show it in toast/UI.

### 2.6 Supervisor lifecycle (supervisor.ts)

`apps/electron/src/main/supervisor.ts` — `class Supervisor`:

```ts
interface SupervisorOptions { goCoreBinary:string; grpcAddr:string; httpAddr:string; dbPath?:string; token?:string; }

class Supervisor{
  proc: ChildProcess|null; ready=false; token:string; queue:PendingRequest[] (max 100);
  async start(){ await spawn(); startHeartbeat(); }
  stop(){ clearInterval(heartbeat); proc?.kill(); }
  private async spawn(){
    const bin = fs.existsSync(goCoreBinary) ? goCoreBinary : null;
    if(!bin) proc=spawn('go',['run','apps/go-core/cmd/go-core',...args]); else proc=spawn(bin,args);
    await awaitReady(); // regex GO_CORE_READY addr=... http=... token=...
    proc.on('exit',()=>{ ready=false; scheduleRestart(); });
  }
  private awaitReady():Promise<void>{ /* 15s timeout, parse GO_CORE_READY, drainQueue */ }
  private scheduleRestart(){ backoff [200,500,1000,2000,5000], rotate token, setTimeout(spawn) }
  private startHeartbeat(){ setInterval(()=>ping(),5000) }
  async forwardToGo(channel,payload){ if(!ready) enqueue|max QUEUE_FULL; else dispatch gRPC(map channel→RPC) }
}
```

**Details:**
- `GO_CORE_READY addr=<grpc> http=<http> token=<64hex>` is a single parseable stdout line (regex `/GO_CORE_READY\s+addr=(\S+)\s+http=(\S+)\s+token=(\S+)/`).
- Go args: `--grpc-addr <unix|127.0.0.1:0> --http-fallback-addr 127.0.0.1:0 --token <hex> --db <path>`.
- Heartbeat `Ping` gRPC; 2x miss → `proc.kill()` → `exit` handler restarts.
- Queue drains on becoming ready; `QUEUE_FULL` if >100.

**Go side (`cmd/go-core/main.go`):**
```go
flag.Bool("headless", false, "run headless")
flag.String("grpc-addr", "127.0.0.1:0", "gRPC addr")
flag.String("http-fallback-addr", "127.0.0.1:0", "HTTP fallback")
// in --headless: fmt.Printf("GO_CORE_READY addr=%s http=%s token=%s\n", grpcAddrStr, httpAddrStr, token)
signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
```

### 2.7 Security

- Electron `BrowserWindow` options: `webPreferences:{ contextIsolation:true, nodeIntegration:false, sandbox:true, preload: path.join(__dirname,'../preload/preload.js') }` + CSP in `window/csp.ts`.
- Go: localhost/unix socket only, token rotated per restart, `Ping` verifies liveness, graceful shutdown 5s.
- Payload validation in `channels.ts:validate` (zod or manual) prevents injection.

## 3. Sequence diagram (see also module-diagram.md §3)

Ref. `module-diagram.md §3.1-3.3` for pagination/streaming/supervision sequences.

## 4. Fallbacks and degradation

- If gRPC `UNAVAILABLE`, supervisor retries HTTP fallback (`GET /health`, `POST /commits` JSON).
- If Go does not start in 15s → `GO_CORE_READY timeout` → retry backoff.
- Renderer offline (Go down + queue full) → `AppError{QUEUE_FULL}` toast + retry button.

## 5. Verification

```bash
buf lint                          # proto lint ok
buf generate --template buf.gen.yaml  # gen/go + gen/ts
go vet ./...                      # supervisor.ts types align with proto
npm run build --workspace=@singularitree/electron  # preload compiles
go run ./apps/go-core/cmd/go-core --headless --grpc-addr 127.0.0.1:0 --http-fallback-addr 127.0.0.1:0 | grep GO_CORE_READY
```
