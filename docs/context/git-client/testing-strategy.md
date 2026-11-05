# Testing Strategy

## 1. Pyramid

```
e2e (playwright)  5%
integration (testcontainers, real Git repo) 15%
unit (vitest / go test) 80%
```

## 2. Angular (vitest)

- **Runner:** `vitest` (Vite) — `apps/angular` with `environment: 'jsdom'`.
- **Matchers:** `@testing-library/angular` + `expect`.
- **Mocks:** `window.gitClientApi` globally mocked; `IpcBridge` spy.
- **Stores:** test without DOM:
  ```ts
  beforeEach(()=> (globalThis as any).window = {gitClientApi: mockApi});
  it('GraphStore loads window', async()=>{
    mockApi.getCommits.mockResolvedValue({commits: fixtures, total: 1000});
    await store.loadWindow('repo-1', 0, 200);
    expect(store.commits().length).toBe(200);
  });
  ```
- **Components:** `render(RepoPage)` with `graph-row` stub, `cdkVirtualScroll` mock, Monaco mock (`monaco-editor` is heavy: `vi.mock('monaco-editor')`).
- **Coverage:** `vitest --coverage` (v8), threshold 80% statements.

Config `apps/angular/vite.config.ts` + `setupFiles: ['src/test-setup.ts']`.

## 3. Go core (go test + testify)

- **Runner:** `go test ./...` with `testify/assert` + `require`.
- **Domain:** pure, no IO:
  ```go
  func TestNewOid(t *testing.T){
    _, err := domain.NewOid("abc"); assert.ErrorIs(t, err, domain.ErrInvalidOid)
  }
  ```
- **Services:** mocked ports (interfaces `GitPort`, `CachePort`):
  ```go
  type MockGitPort struct{ commits []domain.Commit }
  func (m *MockGitPort) List(ctx, repoID, off, lim) ... { return m.commits[off:lim], len(m.commits), nil }
  func TestGraphService_Lanes(t *testing.T){
    svc := service.NewGraphService(&MockGitPort{...}, nil)
    lanes, _ := svc.Lanes(ctx, repoID, commits)
    assert.Len(t, lanes, len(commits))
  }
  ```
- **Adapters:** `adapter/git` tests with a real temporary repo (`t.TempDir()` + `git init` + fixture commits) — no mock.
- **SQLite:** `repository` tests with `modernc.org/sqlite` in-memory (`:memory:`) + migrations applied; testcontainers optional for ephemerality.
- **gRPC:** `buf` stubs + `grpc/test` (`google.golang.org/grpc/test/bufconn`) — test `GitCore` server without TCP.

Canonical command (from `apps/go-core`):
```bash
go test ./... -race -count=1
go vet ./...
```

## 4. Integration (testcontainers / real repos)

- **testcontainers-go** for SQLite not needed (file); for Git use a fixture repo:
  ```bash
  mkdir -p /tmp/test-repo && cd /tmp/test-repo && git init && git config user.email test@example.com
  ```
- **Large graph:** script `tools/scripts/gen-large-repo.sh` (generates a synthetic 50k-commit repo) for perf test `Lanes` <100ms.
- **Watcher:** `fsnotify` test with `os.WriteFile` + eventual assertion `FsChangedEvent` emitted (flaky → retry).

## 5. E2E (Playwright)

- **Scope:** `apps/angular` + `apps/electron` + `apps/go-core --headless` real.
- **Fixtures:** Playwright `electron` launcher:
  ```ts
  import { _electron as electron } from 'playwright';
  const app = await electron.launch({ args: ['apps/electron/dist/main.js'] });
  const page = await app.firstWindow();
  await page.getByTestId('repo-list').click();
  await expect(page.getByTestId('graph-row')).toHaveCount(20);
  ```
- **Cases:** open repo, graph scroll+prefetch, stage/commit, diff Monaco, branch checkout, fetch progress bar.
- **CI:** `playwright test` on `ubuntu` + `windows` + `macos` matrix; artifact `trace.zip`.

**Status (Phase 0):** the E2E renderer↔ipcMain segment (criterion 6) is **deferred** to the Week 7 Playwright Electron smoke (ADR-011). Current coverage: real round-trip **Electron-main → gRPC → Go → `exec git` → repo** (not skipped), plus compile-time typecheck and unit mapping tests.

## 6. Contracts

- **buf lint/breaking:** `tools/ci/verify-contracts.sh`:
  ```bash
  buf lint
  buf breaking --against '.git#branch=main'
  buf generate --dry-run
  ```
- **Gen drift check:** CI fails if `gen/go` or `gen/ts` are outdated.

## 7. Performance / Large repo

- Benchmark `go test -bench=BenchmarkLanes` for 50k commits.
- Angular perf: `vitest` bench virtual scroll 1000 rows (row render <2ms).

## 8. CI (planned)

```yaml
- run: buf lint && buf breaking
- run: go vet ./... && go test ./... -race -count=1   # in apps/go-core
- run: npm test --workspace=@singularitree/angular -- --coverage
- run: npm run build --workspaces
- run: npx playwright test
```

## 9. Minimum MVP matrix

| Area | Unit | Integration | E2E |
|------|------|-------------|-----|
| Domain Oid/Repo | ✓ |  |  |
| Graph Lanes | ✓ (fixture DAG) | ✓ (large repo 50k) |  |
| Cache (SQLite) | ✓ (in-memory) | ✓ (WAL) |  |
| Watcher debounce | ✓ (mock) | ✓ (real fsnotify) |  |
| IpcBridge | ✓ (mock window) |  | ✓ |
| GraphStore pagination | ✓ |  | ✓ (scroll) |
| Diff Monaco | ✓ (mock) |  | ✓ (render) |
| Supervisor restart |  | ✓ (kill Go, queue) |  |

## 10. What not to test in MVP

- Real remotes push/fetch against GitHub (mock `GitPort`); e2e against a local fixture.
- SSH auth (V1).
