import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { Commit, Diff } from '@contracts/domain';
import {
  DiffViewer,
  ToggleGroupComponent,
  WorkspaceSplitComponent,
  type HunkActionSlot,
} from '@singularitree/ui-kit';
import { CommitFocusService } from '@core/services/commit-focus.service';
import { DiffModeService } from '@core/services/diff-mode.service';
import type { DiffMode } from '@core/services/diff-mode.service';
import { IpcBridge } from '@core/services/ipc-bridge.service';
import { PreferencesService } from '@core/services/preferences.service';
import { RepoState } from '@core/services/repo-state.service';
import { CommitViewModeService } from '../../commit-view-mode.service';
import { GraphStore, WIP_OID } from '../../graph/graph.store';
import { CommitDetailsPanel } from '../../graph/ui/commit-details-panel';
import { ChangesPanel } from '../../status/ui/changes-panel';
import { isHunkActionable } from '../../status/ui/hunk-actions.model';
import { FileStatusStore } from '../file-status.store';
import type { FileStatusVariant } from '../file-status.models';
import { commitChangeSummary, toSingleFileDiff } from '../file-status-mappers';
import { FileDiffList } from '../ui/file-diff-list';
import { FileStatusVariantBar } from '../ui/file-status-variant-bar';

/**
 * "File Status" screen (ADR-0029): the file list on the LEFT, the selected
 * file's diff on the RIGHT — the diff is always on the right, never on the left.
 *
 * Three variants share that scaffold: **local** reuses the existing working-tree
 * `st-changes-panel` (with the pinned-commit `st-commit-details-panel` section
 * rendered above it as the contrast anchor / entry point), **commit** reuses
 * `st-commit-details-panel` as the WHOLE commit view — subject + body, or the
 * panel's own paths-only changed-file list, plus its metadata footer — and
 * **pull request** diffs a local ref against a base branch. The screen never talks to
 * Git: every value comes from `FileStatusStore`, which composes the route-scoped
 * `StatusStore` and calls the existing `getStatus`/`getDiff`/`getBranches` RPCs
 * through `IpcBridge`.
 *
 * The right pane is a **pure projection**: `toSingleFileDiff` lifts the selected
 * file into a single-file `Diff` for the `DiffViewer`, so the whole diff is
 * never handed to the viewer.
 *
 * Hunk/line actions live INLINE inside `st-diff-viewer` now: the page supplies
 * per-hunk action slots (`hunkActions`) for the selected actionable unstaged
 * file, and the viewer renders the buttons/checkboxes and echoes back
 * `hunkIndex`/`lineIndex` — the exact indices the core's per-hunk RPCs address.
 *
 * The persisted diff typography and pane-width preferences now flow through the
 * viewer's and split's inputs.
 */
@Component({
  selector: 'st-file-status-page',
  standalone: true,
  imports: [
    ChangesPanel,
    CommitDetailsPanel,
    DiffViewer,
    FileDiffList,
    FileStatusVariantBar,
    ToggleGroupComponent,
    WorkspaceSplitComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-workspace-split [showDetail]="true" detailTitle="" [detailWidth]="detailWidth()" [resizable]="true" (detailWidthResized)="setPaneWidth($event)">
      <!-- pinned LEFT: variant bar + the variant body -->
      <div class="st-file-status__left" detail>
        <st-file-status-variant-bar
          [variant]="fs.variant()"
          [pendingCount]="fs.unstagedFiles().length"
          [branches]="branchNames()"
          [baseRef]="fs.baseRef()"
          [targetRef]="fs.targetRef()"
          (variantChange)="onVariantChange($event)"
          (baseRefChange)="fs.setBaseRef($event)"
          (targetRefChange)="fs.setTargetRef($event)"
        />

        <div
          class="st-file-status__body"
          [class.st-file-status__body--local]="fs.variant() === 'local'"
          [class.st-file-status__body--commit]="fs.variant() === 'commit'"
        >
          @switch (fs.variant()) {
            @case ('local') {
              <!--
                Contrast anchor / entry point: the SAME pinned-commit section
                the commit variant uses, but here it heads the working-tree
                column. Unlocked it renders the panel's empty state (with the
                History shortcut) so picking a commit is one click away; locked
                it shows the pinned commit above the changes it contrasts with.
                Both panel sectors are opted out (showSubject/showFiles
                false): the page owns this screen's identity, so the panel
                renders identity + metadata only and never grows its own switch.
              -->
              <st-commit-details-panel
                [commit]="graph.lockedCommit()"
                [isWip]="false"
                [showSubject]="false"
                [showFiles]="false"
                [navMode]="graph.lockedCommit() ? 'release' : 'history'"
                [locked]="graph.lockedOid() !== null"
                [showInGraph]="true"
                (release)="releaseCommit()"
                (lockToggle)="toggleLock()"
                (revealInGraph)="showInGraph()"
                (openHistory)="goHistory()"
              />
              <st-changes-panel
                [stagedFiles]="fs.stagedFiles()"
                [unstagedFiles]="fs.unstagedFiles()"
                [message]="fs.commitMessage()"
                [busy]="fs.filesLoading()"
                [selectedPath]="fs.selectedPath()"
                [statusError]="fs.statusError()"
                [commitError]="fs.commitError()"
                (stage)="fs.stage($event)"
                (unstage)="fs.unstage($event)"
                (discardFile)="fs.discardFiles([$event])"
                (messageChange)="fs.setMessage($event)"
                (commit)="fs.commit()"
                (fileSelect)="fs.selectFile($event)"
              />
            }
            @case ('commit') {
              <!--
                The PANEL owns the whole commit view, exactly like History: its
                content region holds the subject/body (description mode) or the
                changed-file list (files mode, paths only), and its metadata
                footer is the last element of the column. The panel is the SOLE
                scroller here: the page renders no summary and no separate file
                list. The rows are selectable because the right pane projects a
                single file, so picking a row is how the diff changes. The
                header's contextual action is "History": following the commit
                hands it to the graph via CommitFocusService.
              -->
              <st-commit-details-panel
                [commit]="fs.activeCommit()"
                [isWip]="false"
                [showSubject]="true"
                [showFiles]="true"
                [filesSelectable]="true"
                [selectedPath]="fs.selectedPath()"
                [showViewSwitch]="true"
                [mode]="viewMode.mode()"
                [changedFiles]="changedPaths()"
                [navMode]="'history'"
                [locked]="graph.lockedOid() === fs.activeCommit()?.oid?.hex"
                [showInGraph]="true"
                (modeChange)="viewMode.setMode($event)"
                (fileSelect)="fs.selectFile($event)"
                (openHistory)="goHistory()"
                (lockToggle)="toggleLock()"
                (revealInGraph)="showInGraph()"
              />
            }
            @case ('pr') {
              <p class="st-file-status__summary" data-testid="file-status-summary">
                {{ summaryText() }}
              </p>
              <st-file-diff-list
                [files]="fs.diffFiles()"
                [selectedPath]="fs.selectedPath()"
                (fileSelect)="fs.selectFile($event)"
              />
            }
          }
        </div>
      </div>

      <!-- flexible RIGHT: the selected file's diff, always -->
      <div class="st-file-status__right" data-testid="file-status-diff">
        @if (untrackedSelected()) {
          <p class="st-file-status__notice" data-testid="file-status-untracked" i18n>
            Untracked file — nothing to diff until it is staged.
          </p>
        }
        @if (fs.selectedPath() && rightFileDiff()) {
          <header class="st-file-status__diff-header st-hairline">
            <span class="st-file-status__diff-path st-mono">{{ fs.selectedPath() }}</span>
            @if (!rightFileDiff()!.isBinary && !rightFileDiff()!.hasConflictMarkers) {
              <span
                class="st-file-status__diff-stats st-mono st-tabular-nums"
                data-testid="file-status-diff-stats"
              >
                <span class="st-file-status__diff-add">+{{ rightFileDiff()!.additions }}</span>
                <span class="st-file-status__diff-del">−{{ rightFileDiff()!.deletions }}</span>
              </span>
            }
            <!--
              Hidden while inline hunk actions are supplied: the action grid
              ignores side-by-side, so an inert layout toggle would mislead. The
              read-only paths (commit/PR) keep it.
            -->
            @if (hunkActionSlots() === null) {
              <st-toggle-group
                class="st-file-status__diff-mode"
                data-testid="diff-mode-toggle"
                [ariaLabel]="diffModeLabel"
                [options]="diffModeOptions()"
                [value]="diffMode.mode()"
                (valueChange)="onDiffMode($event)"
              />
            }
          </header>
        }
        <st-diff-viewer
          [diff]="rightFileDiff()"
          [loading]="fs.rightLoading()"
          [errorMsg]="fs.rightError()"
          [truncated]="fs.truncated()"
          [renderSideBySide]="diffMode.sideBySide()"
          [fontSize]="diffFontSizePx()"
          [wordWrap]="diffWordWrapOn()"
          [hunkActions]="hunkActionSlots()"
          (hunkAction)="onHunkAction($event)"
          (hunkLineToggle)="onHunkLineToggle($event)"
        />
      </div>
    </st-workspace-split>
  `,
  styles: `
    :host {
      display: flex;
      height: 100%;
      min-height: 0;
      color: var(--st-color-text);
    }

    :host st-workspace-split {
      flex: 1 1 auto;
      min-height: 0;
    }

    .st-file-status__left {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }

    /* The local and commit variants own the column's height.
       - local: the changes panel owns a bounded column and its own scroll, so
         its commit box pins to the pane bottom.
       - commit: the panel IS the column and its own content region is the
         single scroller, so the metadata footer has to land at the BOTTOM of
         the pane, not right under the message.
       Scoped with :has() to each variant's mount point, so the pr variant —
       which keeps a content-sized column and relies on the body's own
       overflow — is untouched. */
    .st-file-status__left:has(st-changes-panel),
    .st-file-status__left:has(.st-file-status__body--commit) {
      flex: 1 1 auto;
    }

    .st-file-status__body {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--st-space-2);
      min-height: 0;
      padding: var(--st-space-2) var(--st-space-3);
      overflow: auto;
      font-size: var(--st-font-12);
    }

    .st-file-status__summary {
      flex: none;
      margin: 0;
      font-family: var(--st-font-mono);
      font-size: var(--st-font-11);
      opacity: 0.75;
    }

    /* The pinned-commit section is content-sized in every variant; the local
       variant heads the column above the changes panel. */
    :host st-commit-details-panel {
      flex: 0 1 auto;
      min-height: 0;
    }

    /*
      Commit variant: the panel IS the column. Its own content region scrolls,
      so the column must not scroll too (that would nest two scrollers and
      detach the panel's pinned metadata footer). The panel stretches to fill
      the leftover height: flex: 1 1 auto + min-height: 0.
    */
    .st-file-status__body--commit {
      overflow: hidden;
    }

    .st-file-status__body--commit st-commit-details-panel {
      flex: 1 1 auto;
      min-height: 0;
    }

    :host st-file-diff-list {
      flex: 1 1 auto;
      min-height: 0;
    }

    .st-file-status__right {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
    }

    .st-file-status__notice {
      flex: none;
      margin: 0;
      padding: var(--st-space-3);
      font-size: var(--st-font-12);
      opacity: 0.75;
    }

    :host st-diff-viewer {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
    }

    .st-file-status__diff-header {
      display: flex;
      align-items: center;
      gap: var(--st-space-3);
      flex: none;
      padding: 0 var(--st-space-3);
      min-height: var(--st-size-row-tree-dense);
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
    }

    .st-file-status__diff-path {
      flex: 1 1 auto;
      min-width: 0;
      word-break: break-all;
    }

    .st-file-status__diff-stats {
      display: flex;
      gap: var(--st-space-2);
      flex: none;
    }

    .st-file-status__diff-add {
      color: var(--st-color-add);
    }

    .st-file-status__diff-del {
      color: var(--st-color-remove);
    }

    .st-file-status__diff-mode {
      flex: none;
      margin-left: auto;
    }
  `,
})
export class FileStatusPage {
  readonly fs = inject(FileStatusStore);
  /** Renderer-local diff-layout preference (unified by default). */
  readonly diffMode = inject(DiffModeService);
  /**
   * Route-scoped `description | files` choice shared with the History aside.
   * The mode is deliberately NOT component-local: the panel is unmounted across
   * `/repo` ↔ `/repo/file-status`, so only the shared service lets a pick
   * survive that navigation.
   */
  protected readonly viewMode = inject(CommitViewModeService);

  /**
   * Shared, route-scoped graph. Exposed to the template because the local and
   * commit variants read the padlock/pinned commit directly.
   */
  protected readonly graph = inject(GraphStore);
  private readonly repoState = inject(RepoState);
  private readonly bridge = inject(IpcBridge);
  private readonly destroyRef = inject(DestroyRef);
  private readonly prefs = inject(PreferencesService);
  /** Optional so unit tests without a router keep working (navigation no-ops). */
  private readonly router = inject(Router, { optional: true });
  /** Deep-link hand-off: queue a commit focus for `RepoPage` to consume. */
  private readonly commitFocus = inject(CommitFocusService);

  /** Last observed `RepoState.statusRefreshRequested` token (dedupes the effect). */
  private lastStatusRefresh = this.repoState.statusRefreshRequested();

  /** Changed paths of the active commit, feeding the panel switch's file count. */
  readonly changedPaths = computed<readonly string[]>(() =>
    this.fs.diffFiles().map((file) => file.path),
  );

  /**
   * The persisted `st:paneWidth` drives the pinned left pane; `null` keeps the
   * 380px token default.
   */
  readonly detailWidth = computed<string | null>(() => {
    const width = this.prefs.paneWidth();
    return width ? `${width}px` : null;
  });

  /**
   * Persisted diff typography preferences passed into the dumb viewer: the
   * numeric font size and the soft-wrap flag.
   */
  readonly diffFontSizePx = computed(() => Number(this.prefs.diffFontSize()));
  readonly diffWordWrapOn = computed(() => this.prefs.diffWordWrap() === 'on');

  /**
   * Last graph selection this screen followed, resolved to the oid it names
   * (`null` = nothing/WIP selected). A sentinel (not `null`) on the first run, so
   * a cold deep link still opens the working tree. Updated only when the screen
   * actually dispatches, so an unchanged resolved selection is a no-op.
   */
  private lastFollowedOid: string | null | undefined = undefined;

  /**
   * The single-file `Diff` fed to the viewer: a pure projection of the currently
   * selected file, never the whole diff.
   */
  readonly rightFileDiff = computed<Diff | null>(() =>
    toSingleFileDiff(this.fs.wholeDiff(), this.fs.selectedPath()),
  );

  /**
   * True when the local variant has a selected status row that is genuinely
   * untracked (porcelain `?` code), which `git diff HEAD` excludes until it is
   * staged. The right pane then shows an explicit notice instead of the viewer
   * silently projecting an empty diff (the viewer input stays null). Absence from
   * `wholeDiff().files` is NOT sufficient: a truncated diff legitimately omits
   * tracked files (ADR-0020 cap), so those must never be mislabeled as untracked.
   */
  readonly untrackedSelected = computed<boolean>(() => {
    if (!this.fs.isLocal()) return false;
    // A capped diff omits real files: never infer "untracked" from that.
    if (this.fs.truncated()) return false;
    const path = this.fs.selectedPath();
    if (!path) return false;
    const status = [...this.fs.stagedFiles(), ...this.fs.unstagedFiles()].find(
      (file) => file.path === path,
    );
    // Only the porcelain `?` untracked code qualifies.
    if (status?.unstaged !== '?') return false;
    const diff = this.fs.wholeDiff();
    if (!diff) return false;
    // Untracked files have no `git diff HEAD` section.
    return !diff.files.some((file) => file.path === path);
  });

  /** Branch names offered by the PR base/target controls. */
  readonly branchNames = computed<string[]>(() => this.fs.branches().map((branch) => branch.name));

  /** Segments of the diff-pane layout toggle. */
  readonly diffModeOptions = computed(() => [
    { value: 'unified', label: $localize`Unified` },
    { value: 'side-by-side', label: $localize`Side by side` },
  ]);

  /** Accessible name for the diff-pane layout toggle. */
  readonly diffModeLabel = $localize`Diff layout`;

  /** Accessible names of the inline per-hunk actions. */
  readonly a11yStageHunk = $localize`Stage hunk`;
  readonly a11yDiscardHunk = $localize`Discard hunk`;

  /** Count-only summary of the diff shown by the commit/PR variants. */
  readonly changeSummary = computed(() => commitChangeSummary(this.fs.wholeDiff()));

  /** One-line summary: `+12 −3 across 4 files`. */
  readonly summaryText = computed(() => {
    const additions = this.changeSummary().additions;
    const deletions = this.changeSummary().deletions;
    const filesChanged = this.changeSummary().filesChanged;
    const files = filesChanged === 1 ? $localize`1 file` : $localize`${filesChanged} files`;
    return $localize`+${additions} −${deletions} across ${files}`;
  });

  // -- inline hunk actions (viewer-driven, ADR-0020) ------------------------

  /**
   * Page-owned per-line selection: `hunkIndex` → sorted 0-based indices into
   * `hunk.lines`. Held here (not in the viewer) because the asynchronously
   * refreshed diff can re-render at any time, and the page is the one place
   * that survives it and owns the `hunkIndex`/`lineIndex` addressing.
   */
  private readonly selectedHunkLines = signal<Record<number, number[]>>({});

  /**
   * Per-hunk action slots for the selected actionable unstaged file, or `null`
   * for every read-only path (commit/PR variants, no selection, staged/binary/
   * conflicted/deleted files) so the viewer keeps its Monaco surface. One slot
   * per hunk, addressed by index — the core re-derives the patch (ADR-0020).
   */
  readonly hunkActionSlots = computed<readonly HunkActionSlot[] | null>(() => {
    if (!this.fs.isLocal()) return null;
    const path = this.fs.selectedPath();
    if (!path) return null;
    const file = this.fs.selectedUnstagedFile();
    if (!file || !isHunkActionable(file)) return null;
    const selected = this.selectedHunkLines();
    const disabled = this.fs.filesLoading();
    return file.hunks.map((_, hunkIndex) => ({
      hunkIndex,
      actions: [
        { key: 'stage', icon: 'plus', label: this.a11yStageHunk, disabled },
        { key: 'discard', icon: 'discard', label: this.a11yDiscardHunk, disabled },
      ],
      selectedLines: selected[hunkIndex] ?? [],
    }));
  });

  constructor() {
    // Mirror `RepoPage`: a cold deep link (or the sidebar) can land here with no
    // graph loaded yet, so hydrate the shared route-scoped `GraphStore` from the
    // active repository. Guarded by id because `openRepository` is not idempotent
    // (it refreshes `last_opened_at`).
    effect(() => {
      const active = this.repoState.activeRepo();
      if (!active || this.graph.repoId() === active.id) return;
      void this.graph.openRepository(active.fsPath);
    });

    // The screen always follows the graph's repository and HEAD.
    effect(() => {
      this.fs.setRepoId(this.graph.repoId());
      this.fs.setHeadOid(this.graph.commits()[0]?.oid?.hex ?? null);
    });

    // The graph selection picks the variant: a real commit present in the loaded
    // window opens the commit variant, anything else (the WIP row, no selection)
    // opens the working tree. Following the selection keeps the screen in sync
    // when another commit is picked while the page is open.
    effect(() => {
      const repoId = this.graph.repoId();
      const oid = this.graph.selectedOid();
      // Resolve the followed commit through the lock: once pinned, the cached
      // `lockedCommit()` keeps the commit variant alive even after a reload
      // drops the locked row out of the loaded window.
      const commit =
        repoId && oid && oid !== WIP_OID
          ? this.graph.lockedOid() === oid
            ? this.graph.lockedCommit() ?? undefined
            : this.graph.commits().find((candidate) => candidate.oid?.hex === oid)
          : undefined;
      // Dedupe on the RESOLVED selection, not on `oid`. `commits()` stays a
      // tracked dependency on purpose: a selection whose commit is not yet in
      // the loaded window (the open-commit deep-link focus) resolves to
      // `null` here and must re-fire once the window that names it loads. But a
      // background `reload()` (fs:changed after stage/unstage/commit) installs a
      // NEW `commits()` array that still names the selected commit; without this
      // guard the effect would re-dispatch `openCommit()` and flip the variant
      // bar from `local` back to `commit` while the user is staging. Staging must
      // never change the variant, so an unchanged resolved selection is a no-op.
      const resolved = commit ? oid : null;
      if (resolved === this.lastFollowedOid) return;
      this.lastFollowedOid = resolved;
      if (commit) void this.fs.openCommit(commit);
      else void this.fs.openLocal();
    });

    // Switching the selected file invalidates every per-hunk line index: the new
    // file's hunks are unrelated, so a selection carried over from the previous
    // file would render as checked lines on a file the user never touched — and
    // a Discard would then destroy lines that were never selected there. Reset
    // the whole map whenever the selected path changes.
    let lastSelectedPath: string | null | undefined = undefined;
    effect(() => {
      const path = this.fs.selectedPath();
      if (path === lastSelectedPath) return;
      lastSelectedPath = path;
      this.selectedHunkLines.set({});
    });

    // A successful commit moves HEAD: reload the graph window.
    effect(() => {
      if (this.fs.graphReloadRequested() > 0) this.graph.reload();
    });

    // A ref mutation that may have moved HEAD or dirtied the tree (ADR-028) used
    // to be observed by `StatusWorkspace`, the band ADR-0030 item 1 removed. Its
    // working-tree half lives here: File status is now the single inspection
    // surface.
    effect(() => {
      const token = this.repoState.statusRefreshRequested();
      if (token === this.lastStatusRefresh) return;
      this.lastStatusRefresh = token;
      this.refreshForExternalChange();
    });

    // External file changes may have moved HEAD or dirtied the window: refresh
    // through the same path.
    const unsubscribe = this.bridge.onFsChanged(() => this.refreshForExternalChange());
    this.destroyRef.onDestroy(unsubscribe);
    this.destroyRef.onDestroy(() => this.fs.clearVariant());
  }

  /**
   * Reload the graph window and, while the working tree is on screen, re-open
   * the local variant — keeping the user's file selection across the refresh.
   * A commit/PR diff is an immutable historical comparison and must not be
   * clobbered into the working tree, so only the local variant re-opens.
   */
  private refreshForExternalChange(): void {
    this.graph.reload();
    if (!this.fs.isLocal()) return;
    const selected = this.fs.selectedPath();
    void this.fs.openLocal().then(() => {
      // Keep the user's file selection across the refresh.
      if (selected) this.fs.selectFile(selected);
    });
  }

  /** Switch variant through the store; only the store owns the variant state. */
  onVariantChange(variant: FileStatusVariant): void {
    if (variant === 'local') {
      void this.fs.openLocal();
      return;
    }
    if (variant === 'pr') {
      void this.fs.openPr();
      return;
    }
    // Prefer the locked anchor (the commit the padlock is actually pinning) over
    // a possibly stale `activeCommit` retained across `openLocal`, then the
    // selection that resolves to a loaded row.
    const commit = this.graph.lockedCommit() ?? this.fs.activeCommit() ?? this.selectedCommit();
    // Without a commit to show, fall back to the working tree rather than an
    // empty screen: the variant state only changes through `openCommit`.
    if (!commit) {
      void this.fs.openLocal();
      return;
    }
    // Reaching the commit variant with no graph selection (release, then this
    // segment, with `activeCommit` retained) leaves the padlock enabled but
    // inert: `graph.lock()` needs a selected oid present in `rows()`. Select the
    // resolved commit first so the padlock has something to lock — skipped when a
    // lock already exists, because the locked commit is then already the selection.
    const oid = commit.oid?.hex ?? null;
    if (oid && oid !== this.graph.selectedOid() && this.graph.lockedOid() === null) {
      this.graph.select(oid);
    }
    void this.fs.openCommit(commit);
  }

  /** Release the pinned selection: drop the lock AND the selection. */
  releaseCommit(): void {
    this.graph.release();
  }

  /** Toggle the graph lock: pin the current commit, or lift the pin. */
  toggleLock(): void {
    if (this.graph.lockedOid()) this.graph.unlock();
    else this.graph.lock();
  }

  /**
   * Navigate to History, following the commit in view when there is one.
   *
   * Only the COMMIT variant has a commit in view. The local variant renders the
   * empty-branch History shortcut, and `FileStatusStore.openLocal()` keeps the
   * last viewed commit in `activeCommit()` — following that stale value would
   * select a commit the user is no longer looking at.
   */
  goHistory(): void {
    const oid = this.fs.variant() === 'commit' ? (this.fs.activeCommit()?.oid?.hex ?? null) : null;
    const repoId = this.graph.repoId();
    if (oid && repoId) this.commitFocus.request(repoId, oid);
    void this.router?.navigate(['/repo']);
  }

  /**
   * Reveal the current commit in the graph. The oid is resolved through the
   * lock/selection because in the local variant there is no `activeCommit()`;
   * the focus hand-off makes this work even when the commit is outside the
   * loaded window (RepoPage runs the bounded `focusCommit` paging).
   */
  showInGraph(): void {
    const oid =
      this.fs.activeCommit()?.oid?.hex ??
      this.graph.lockedCommit()?.oid?.hex ??
      this.graph.selectedOid();
    const repoId = this.graph.repoId();
    if (repoId) this.commitFocus.request(repoId, oid ?? '');
    void this.router?.navigate(['/repo']);
  }

  /** Apply a diff-layout picked by the user (renderer-local preference). */
  onDiffMode(value: string): void {
    this.diffMode.setMode(value as DiffMode);
  }

  /**
   * The split emits pixels and the service owns persistence/validation, so this
   * only rounds the value and forwards it.
   */
  setPaneWidth(width: number): void {
    this.prefs.setPaneWidth(String(Math.round(width)));
  }

  /**
   * A per-hunk action button was clicked. The addressing is by indices only
   * (ADR-0020): the page forwards the current line selection and clears the
   * WHOLE selection map once the mutation is dispatched, because the reload
   * re-indexes every hunk — so the next action starts from a fresh, valid map.
   */
  onHunkAction(event: { hunkIndex: number; actionKey: string }): void {
    const path = this.fs.selectedPath();
    if (!path) return;
    const lines = this.selectedHunkLines()[event.hunkIndex] ?? [];
    if (event.actionKey === 'stage') {
      void this.fs.stageHunk(path, event.hunkIndex, lines);
    } else if (event.actionKey === 'discard') {
      // Hunk discard has never asked for a file-level confirmation; the action
      // itself is the intent.
      void this.fs.discardHunk(path, event.hunkIndex, lines);
    } else {
      return;
    }
    // A mutation reloads the worktree diff and re-indexes EVERY hunk, so the
    // whole map is stale — clearing only the acted-on hunk would leave the other
    // indices pointing at unrelated lines in the refreshed diff.
    this.selectedHunkLines.set({});
  }

  /** Toggle one changed line's membership in a hunk's selection (sorted). */
  onHunkLineToggle(event: { hunkIndex: number; lineIndex: number }): void {
    this.selectedHunkLines.update((current) => {
      const lines = current[event.hunkIndex] ?? [];
      const next = lines.includes(event.lineIndex)
        ? lines.filter((index) => index !== event.lineIndex)
        : [...lines, event.lineIndex].sort((a, b) => a - b);
      return { ...current, [event.hunkIndex]: next };
    });
  }

  /** Commit the graph currently has selected, or null for WIP/no selection. */
  private selectedCommit(): Commit | null {
    return this.graph.selectedRow()?.commit ?? null;
  }
}
