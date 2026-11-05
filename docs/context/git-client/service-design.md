# Service design — Go + Angular

## 1. Go services (`apps/go-core/internal/service`)

Hexagonal: services orchestrate ports (`domain/*Port`), never `adapter` details.

### 1.1 RepoService

```go
type RepoService struct { repoPort RepoPort; gitPort GitPort }
func (s *RepoService) Open(ctx, fsPath) (*Repository, error) {
  // validates .git exists (git rev-parse --git-common-dir), normalizes, persists repos table
}
func (s *RepoService) List(ctx) ([]Repository, error)
func (s *RepoService) Remove(ctx, id) error
```

- `Open` is idempotent: if `fs_path` already exists, it updates `last_opened_at`.
- `common_dir` resolves worktrees (`git rev-parse --git-common-dir`).

### 1.2 GitService

```go
type GitService struct { gitPort GitPort; cachePort CachePort }
func (s *GitService) Status(ctx, repoID) ([]FileStatus, error)   // porcelain v2
func (s *GitService) Diff(ctx, repoID, from, to) (Diff, error)
func (s *GitService) Stage(ctx, repoID, paths) error
func (s *GitService) Unstage(ctx, repoID, paths) error
func (s *GitService) Commit(ctx, repoID, message, author) (*Commit, error)
func (s *GitService) Checkout(ctx, repoID, refName) error
func (s *GitService) Fetch/Push/Pull(ctx, repoID, remote, branch) (<-chan Progress, error) // streaming
```

- `Stage/Unstage` invalidates the `file_status` cache.
- `Commit` validates `message` is not empty; hook errors → `COMMIT_FAILED`.

### 1.3 GraphService (commit graph + lanes)

**Problem:** thousands of commits, graph with merges/crossovers, render <100ms for 50k.

```go
type GraphService struct { gitPort GitPort; cachePort CachePort }
func (s *GraphService) Commits(ctx, repoID, offset, limit) ([]Commit, int, error) {
  if cached, ok := cachePort.GetCommits(repoID, offset, limit); ok { return cached }
  commits, total, err := gitPort.List(offset, limit)
  cachePort.SetCommits(repoID, offset, commits)
  return commits, total, err
}
func (s *GraphService) Lanes(ctx, repoID, commits []Commit) ([]Lane, error)
```

**Lanes algorithm (equivalent to `git log --graph`):**
- Input: commits in topological order (`git log --topo-order` or `git rev-list`).
- State: `lanes[]` slots (columns), `nextFree` pool, `commitToLane` map.
- For each commit:
  1. Assign lane: if the commit is a direct child of the previous one in the same lane → reuse; if merge → open a new lane; if orphan → `nextFree`.
  2. For each parent, assign a continued lane; if multiple parents (merge), the extra lanes continue.
  3. Close lanes that have no live commit.
- Complexity O(n * avgParents) ~ O(n).
- Output `Lane{Index, Color, Continues}` per commit, which Angular uses to draw lines.

**Alternative considered:** deriving lanes in Angular; discarded — 50k commits blocks the main thread; Go does it in <50ms.

### 1.4 CacheService

```go
type CacheService struct { store CachePort /* SQLite */ }
func (c *CacheService) GetCommits(repoID, offset, limit) ([]Commit, bool)
func (c *CacheService) SetCommits(repoID, offset, commits)
func (c *CacheService) Invalidate(repoID) // on fs:changed / HEAD move
```

- LRU window: cache only the visible window `200 + 100 prefetch` (see §3).
- `commit_cache` index `(repo_id, committed_at DESC)` for `ORDER BY committed_at DESC LIMIT ? OFFSET ?`.
- Invalidates on `WatcherService` event or `Commit`/`Checkout`/`Fetch` success.

### 1.5 WatcherService

```go
type WatcherService struct { watcherPort WatcherPort; cachePort CachePort; bus EventBus }
func (s *WatcherService) Watch(repoID) (<-chan FsChangedEvent, error) {
  ch, _ := watcherPort.Watch(repoID) // fsnotify .git/HEAD, refs/, index
  go func(){
    debounced := coalesce(ch, 200*time.Millisecond, 300*time.Millisecond) // debounce + coalescing
    for ev := range debounced {
      if isLockFile(ev.Paths) { continue } // .git/index.lock guard
      cachePort.Invalidate(repoID)
      bus.Publish(FsChangedEvent{RepoId: repoID, Paths: ev.Paths})
    }
  }()
  return ch
}
```

- `adapter/watcher/watcher.go` uses `fsnotify` (or `notify` cross-platform), debounce 150-300ms, burst coalescing, `index.lock` filter.
- Wire event: `FsChangedEvent{repo_id, paths}` via `Watch` gRPC streaming → Electron `fs:changed` → Angular `onFsChanged`.

## 2. Angular — Signals stores (`apps/angular/src/app`)

### 2.1 IpcBridge (core)

`core/services/ipc-bridge.service.ts` — typed wrapper over `window.gitClientApi` (see `ipc-strategy.md §1.2`). Generated `gen/ts` will replace `unknown`.

```ts
@Injectable({providedIn:'root'})
export class IpcBridge {
  invoke<K extends keyof GitClientApi>(method:K, req:Params<K>):ReturnType<K>{
    if(!window.gitClientApi) throw {code:'IPC_UNAVAILABLE'} as AppError;
    return (window.gitClientApi[method] as Function)(req);
  }
  onFsChanged(cb:(p:unknown)=>void){ return window.gitClientApi.onFsChanged(cb); }
}
```

### 2.2 Stores (Signals)

Each feature has a standalone store with `signal`, `computed`, `effect`.

**GraphStore** (`features/repo/graph/graph.store.ts` planned):
```ts
export const GraphStore = signalStore(
  withState({ commits:[] as Commit[], lanes:[] as Lane[], total:0, offset:0, loading:false, error:null as AppError|null }),
  withComputed(({commits, lanes})=>({
    rows: computed(()=> commits().map((c,i)=> ({commit:c, lane:lanes()[i]}))),
    hasMore: computed(()=> commits().length < total()),
  })),
  withMethods((store, ipc=IpcBridge)=>({
    async loadWindow(repoId:string, offset:number, limit=200){
      store.loading.set(true);
      try{
        const {commits,total}= await ipc.invoke('getCommits',{repo_id:repoId, offset, limit});
        const lanes = computeLanes(commits); // or comes from Go
        patchState(store,{commits: [...store.commits(), ...commits], lanes, total});
      }catch(e){ store.error.set(e as AppError); } finally{ store.loading.set(false); }
    },
    async prefetch(repoId:string){ if(store.hasMore()) this.loadWindow(repoId, store.commits().length, 100); }
  }))
);
```

- **Windowed pagination:** initial window `200`, prefetch `100` on scroll, infinite scroll with `IntersectionObserver` + CDK `ScrollingModule` or `cdk-virtual-scroll-viewport` (or canvas for 50k).
- **Virtualization:** `@angular/cdk/scrolling` `*cdkVirtualFor` fixed row height (28px) → DOM only ~30 visible rows; lanes drawn with SVG/canvas by `libs/ui-kit/graph-row`.

**StatusStore:**
```ts
withState({ files:[] as FileStatus[], loading:false })
withMethods((store,ipc)=>({
  async refresh(repoId:string){ store.files.set(await ipc.invoke('getStatus',{repo_id:repoId}).then(r=>r.files)); },
  async stage(repoId:string, paths:string[]){ await ipc.invoke('stage',{repo_id:repoId, paths}); await this.refresh(repoId); },
}))
// onFsChanged → debounce 200ms → refresh
```

**DiffStore:**
```ts
withState({ diff:null as Diff|null, loading:false, mode:'side-by-side' as 'side-by-side'|'unified' })
// Monaco diff viewer: large file guard → chunking/worker if >1MB or >5000 lines
```

**RepoStore (global):**
```ts
withState({ repos:[] as Repository[], currentId:null as string|null })
```

**Branch/Tag/Stash stores** similar.

### 2.3 Frontend cache

- Angular does not cache commits beyond `GraphStore` memory (LRU 300). The source-of-truth cache is Go+SQLite; the renderer invalidates on `onFsChanged`/`onRepoChanged`.
- Optional `localStorage` for UI-state (panel sizes, theme) — not Git data.

## 3. Pagination and cache strategy

```
User scroll ──▶ GraphStore.loadWindow(offset, limit=200)
                │ hit? → memory
                ▼ miss
            IpcBridge → Go GraphService → CachePort.GetCommits
                                            │ hit → SQLite commit_cache
                                            ▼ miss
                                          GitPort.List (git log offset/limit)
                                            → CachePort.SetCommits → response
            ──▶ lanes computed (Go or TS) ──▶ virtual scroll render
            ──▶ prefetch 100 on near-bottom
Watcher FsChangedEvent ──▶ Cache.invalidate(repoId) ──▶ GraphStore reload window 0..200
```

- `StreamCommits` for an alternative continuous stream (gRPC server streaming) if the client wants push.
- `total` is used for virtual scrollbar height (`total * rowHeight`).

## 4. Watchers — coalescing

```
fsnotify .git/HEAD, refs/*, index, .git/logs/HEAD
  ──200ms debounce──▶ coalesce burst ──▶ FsChangedEvent{paths}
                     (if only index.lock → ignore)
                                  ──▶ Go Cache.invalidate → gRPC Watch push → Electron → Angular → StatusStore.refresh + GraphStore.reload
```

Window 150-300ms tunable in `watcher/config.go`.

## 5. Error handling and progress

- Each store exposes `error: AppError | null` → toast.
- `Fetch/Push/Pull` progress: Angular subscribes `onProgress` → progress bar + log streaming; Go sends `Progress{percent,message}` per chunk.
- `QUEUE_FULL`/`GO_CORE_UNAVAILABLE` → retry with backoff + banner.

## 6. Testing hooks (see testing-strategy.md)

- Stores testable without Electron: mock global `window.gitClientApi`.
- Go services testable with `MockGitPort`, `MockCachePort`.
- `GraphService.Lanes` unit tests with small DAG fixtures.
```
