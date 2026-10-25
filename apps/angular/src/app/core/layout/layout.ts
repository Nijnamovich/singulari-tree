import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { LiveRegionService, type RepoCardView } from '@singularitree/ui-kit';
import type { Repository, Stash } from '@contracts/domain';
import type { GitFlowConfig } from '@contracts/gitcore';
import { BranchLensStore } from '@core/services/branch-lens.store';
import { CommitFocusService } from '@core/services/commit-focus.service';
import {
  IpcBridge,
  type DeepLinkPayload,
  type MenuNavigatePayload,
} from '@core/services/ipc-bridge.service';
import { RepoState } from '@core/services/repo-state.service';
import { WorkspacesStore } from '@core/services/workspaces.store';
import { copyToClipboard, readClipboardText } from '@core/util/clipboard';
import { baseName, buildRepoDeepLink, isPlausibleGitRemoteUrl } from '@core/util/git-url';
import { GithubAccountStore } from '@features/github-account/github-account.store';
import { RemoteOpsStore } from '@features/remote/remote-ops.store';
import { FetchAllStatus } from '@features/remote/ui/fetch-all-status/fetch-all-status';
import { FetchDialog } from '@features/remote/ui/fetch-dialog/fetch-dialog';
import { PullDialog } from '@features/remote/ui/pull-dialog/pull-dialog';
import { PushDialog } from '@features/remote/ui/push-dialog/push-dialog';
import { BranchCreateDialog } from '@shared/ui/ref-dialogs/branch-create-dialog';
import { CherryPickDialog } from '@shared/ui/ref-dialogs/cherry-pick-dialog';
import { MergeDialog } from '@shared/ui/ref-dialogs/merge-dialog';
import type {
  BranchCreateValue,
  CherryPickValue,
  MergeValue,
  TagCreateValue,
} from '@shared/ui/ref-dialogs/ref-dialog.models';
import { RefDeleteConfirmDialog } from '@shared/ui/ref-dialogs/ref-delete-confirm-dialog';
import { RefRenameDialog } from '@shared/ui/ref-dialogs/ref-rename-dialog';
import { StashDropConfirmDialog } from '@shared/ui/ref-dialogs/stash-drop-confirm-dialog';
import { StashPushDialog } from '@shared/ui/ref-dialogs/stash-push-dialog';
import { TagCreateDialog } from '@shared/ui/ref-dialogs/tag-create-dialog';
import { GitFlowDialog } from '@shared/ui/git-flow-dialog/git-flow-dialog';
import { CloneDialog } from '@shared/ui/clone-dialog/clone-dialog';
import type {
  GitFlowFinishValue,
  GitFlowMode,
  GitFlowStartValue,
} from '@shared/ui/git-flow-dialog/git-flow.models';
import { toLocalRepoCardView } from './local-repo-card-view';
import { CheckoutErrorBanner } from './ui/checkout-error-banner/checkout-error-banner';
import { MergeConflictBanner } from './ui/merge-conflict-banner/merge-conflict-banner';
import { NavRail } from './ui/nav-rail/nav-rail';
import { RepoDrawer } from './ui/repo-drawer/repo-drawer';
import { StatusBar } from './ui/status-bar/status-bar';
import { SwitchBranchConfirmDialog } from './ui/switch-branch-confirm-dialog/switch-branch-confirm-dialog';
import { TopBar, type TopBarTab } from './ui/top-bar/top-bar';

/** Branch-switch attempt awaiting confirmation, either pre-checkout or blocked. */
interface CheckoutPrompt {
  /** Clicked branch display name, used verbatim in the confirmation copy. */
  readonly name: string;
  readonly isRemote: boolean;
  readonly mode: 'confirm' | 'dirty' | 'untracked';
}

/**
 * Application shell: top bar + nav rail + workspace + repo drawer + status bar.
 * The drawer pin state is persisted to localStorage; ref data AND the nav rail's
 * ref lists both come from the root `RepoState`, the active-local-repository
 * source of truth. The top-level menu is the OS-native one, so it is not
 * rendered here.
 */
@Component({
  selector: 'st-layout',
  standalone: true,
  imports: [
    RouterOutlet,
    TopBar,
    NavRail,
    StatusBar,
    RepoDrawer,
    CheckoutErrorBanner,
    PullDialog,
    PushDialog,
    FetchDialog,
    FetchAllStatus,
    SwitchBranchConfirmDialog,
    MergeConflictBanner,
    BranchCreateDialog,
    RefRenameDialog,
    RefDeleteConfirmDialog,
    TagCreateDialog,
    MergeDialog,
    CherryPickDialog,
    StashPushDialog,
    StashDropConfirmDialog,
    GitFlowDialog,
    CloneDialog,
  ],
  templateUrl: './layout.html',
  styleUrls: ['./layout.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LayoutComponent implements OnInit {
  readonly repoState = inject(RepoState);
  /** Root view-only branch lens (ADR-0042), owned by the rail + graph. */
  readonly lens = inject(BranchLensStore);
  readonly remoteOps = inject(RemoteOpsStore);
  readonly workspaces = inject(WorkspacesStore);
  private readonly commitFocus = inject(CommitFocusService);
  private readonly githubAccount = inject(GithubAccountStore);
  private readonly bridge = inject(IpcBridge);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly liveRegion = inject(LiveRegionService);

  /** Current router URL, mirrored into a signal so the rail highlight can react. */
  private readonly currentUrl = signal(this.router.url);

  /**
   * The last text this shell announced about a fetch. It lets the shell clear
   * ONLY its own announcement when the fetch line closes, leaving another
   * producer's message (e.g. the graph's refused-selection notice) untouched.
   */
  private lastFetchAnnouncement: string | null = null;

  /** Top-level routes the OS-native menu may request. */
  private static readonly MENU_ROUTES: ReadonlySet<string> = new Set([
    '/repo',
    '/repos',
    '/github-account',
  ]);

  private readonly LS_DRAWER_PINNED = 'st:drawerPinned';

  /** Whether the repo drawer is docked inline (true) or floats as a popover (false). */
  readonly drawerPinned = signal(true);
  /** Whether the unpinned floating drawer popover is shown. */
  readonly drawerOpen = signal(false);
  /** Whether the nav rail is collapsed to its 40px strip. Not persisted. */
  readonly railCollapsed = signal(false);
  /** Whether the drawer is visible at all (docked or floating). */
  readonly drawerExpanded = computed(() => this.drawerPinned() || this.drawerOpen());
  /** Controlled workspace selection for `<st-nav-rail>`. */
  readonly activeWorkspace = signal('history');

  /**
   * Branch-switch confirmation currently awaiting the user, or null. Opened on
   * every branch click (mode `confirm`) and, after a blocked checkout, driven by
   * the store's `checkoutError` (modes `dirty`/`untracked`); non-dirty failures
   * never open it (they fall back to `st-checkout-error-banner`).
   */
  readonly checkoutPrompt = signal<CheckoutPrompt | null>(null);

  // -- ref mutation dialogs (ADR-028) --------------------------------------
  /** Open create-branch dialog with its default start point, or null. */
  readonly branchDialog = signal<{ startPoint: string } | null>(null);
  /** Open rename dialog for the branch named by this signal, or null. */
  readonly renameDialog = signal<string | null>(null);
  /** Open delete-confirm dialog for a branch or tag, or null. */
  readonly deleteDialog = signal<{ kind: 'branch' | 'tag'; name: string } | null>(null);
  /** Open create-tag dialog with its default target, or null. */
  readonly tagDialog = signal<{ target: string } | null>(null);
  /** Open merge dialog preselected on this ref, or null. */
  readonly mergeDialog = signal<string | null>(null);

  // -- stash + git-flow dialogs (ADR-028 / ADR-027) ------------------------
  /** True while the "stash current changes" dialog is open. */
  readonly stashPushDialog = signal(false);
  /** Stash entry awaiting drop confirmation, or null. */
  readonly stashDropDialog = signal<Stash | null>(null);
  /** Open git-flow dialog with its initial tab, or null. */
  readonly gitFlowDialog = signal<GitFlowMode | null>(null);

  // -- clone (ADR-025) -----------------------------------------------------
  /**
   * Open clone dialog: the prefilled git URL and an optional validation
   * message. Non-null while the dialog is shown; clone itself is V1.4.
   */
  readonly cloneDialog = signal<{ url: string; error: string | null } | null>(null);

  /** Last confirmed branch target, remembered so a blocked retry can re-prompt. */
  private lastAttempt: { name: string; isRemote: boolean } | null = null;

  /** Local tracked repos mapped to the drawer's presentational view model. */
  readonly repoCards = computed<RepoCardView[]>(() => this.repoState.repos().map(toLocalRepoCardView));

  /** Open repository tabs mapped to the top bar's tab strip view model. */
  readonly topBarTabs = computed<TopBarTab[]>(() =>
    this.workspaces.tabs().map((tab) => ({
      id: tab.repoId,
      label: tab.name,
      branch:
        tab.repoId === this.workspaces.activeTabId()
          ? this.repoState.currentBranch() || undefined
          : undefined,
    })),
  );

  /** Display name of the repository whose fetch the status line reports. */
  readonly fetchRepoName = computed<string>(() => {
    const repoId = this.remoteOps.fetchRepoId();
    if (!repoId) return '';
    return this.workspaces.tabs().find((tab) => tab.repoId === repoId)?.name ?? '';
  });

  /** Whether the fetch status line should be visible (a reported repository). */
  readonly fetchOpen = computed(() => Object.keys(this.remoteOps.fetchStatus()).length > 0);

  /**
   * State of the reported repository, derived with the SAME rule the status
   * line renders (`pending` wins over `failed`, which wins over `success`), so
   * the live-region announcement settles with the visible line.
   */
  readonly fetchState = computed<'pending' | 'success' | 'failed' | null>(() => {
    const states = Object.values(this.remoteOps.fetchStatus());
    if (states.includes('pending')) return 'pending';
    if (states.includes('failed')) return 'failed';
    return states.includes('success') ? 'success' : null;
  });

  constructor() {
    // Persist the drawer pin state (the previous width/collapse pair is gone).
    effect(() => {
      const pinned = this.drawerPinned();
      try {
        localStorage.setItem(this.LS_DRAWER_PINNED, String(pinned));
      } catch {}
    });

    // Keep the nav-rail WORKSPACE highlight truthful when navigation originates
    // outside the rail (e.g. the graph/WIP "Changes" hand-off to File status):
    // mirror the router URL and derive the active workspace from it.
    const unsubscribeRoutes = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) this.currentUrl.set(event.urlAfterRedirects);
    });
    this.destroyRef.onDestroy(() => unsubscribeRoutes.unsubscribe());

    effect(() => {
      const url = this.currentUrl();
      if (url.startsWith('/repo/file-status')) this.activeWorkspace.set('status');
      else if (url === '/repo' || url.startsWith('/repo?')) this.activeWorkspace.set('history');
      else if (url === '/repos' || url.startsWith('/repos?')) this.activeWorkspace.set('repos');
      // Every other route has no WORKSPACE entry (github account, settings, and
      // the tab-close fallback): clear any stale highlight.
      else this.activeWorkspace.set('');
    });

    // Lazy per-tab fetch: every activation path (deep link `selectTab`, the
    // drawer, startup re-activation and the neighbour promoted by `closeTab`)
    // funnels through `activeTabId`, so this effect covers them all. It is
    // fire-and-forget: the click/render path is never awaited and the store is
    // single-flight per repository. A status line owned by a DIFFERENT
    // repository is stale after the switch, so drop it here.
    effect(() => {
      const id = this.workspaces.activeTabId();
      const reported = this.remoteOps.fetchRepoId();
      // A line owned by any other repository (including no active tab) is stale
      // after the switch: drop it before the lazy fetch repaints the bar.
      if (reported && reported !== id) this.remoteOps.clearFetch();
      if (!id) return;
      void this.remoteOps.fetchRepoIfStale(id);
    });

    // Publish the repository being fetched to the status-bar live region. The
    // announcement follows the SAME state the visible line renders, so it
    // settles with the fetch instead of claiming to fetch forever; when the
    // line closes, the announcement we own is cleared (another producer's
    // message — e.g. the graph's refused-selection notice — is left alone).
    effect(() => {
      const state = this.fetchState();
      if (!state) {
        if (this.lastFetchAnnouncement !== null) {
          // `untracked`: reading the live message must not make this effect
          // depend on every other producer's announcement.
          if (untracked(() => this.liveRegion.message()) === this.lastFetchAnnouncement) {
            this.liveRegion.announce('');
          }
          this.lastFetchAnnouncement = null;
        }
        return;
      }
      const label =
        state === 'success'
          ? $localize`Repository up to date`
          : state === 'failed'
            ? $localize`Fetch failed`
            : $localize`Fetching repository`;
      const name = this.fetchRepoName();
      const text = name ? `${label} ${name}` : `${label}…`;
      this.lastFetchAnnouncement = text;
      this.liveRegion.announce(text);
    });

    // Take over from the fallback banner whenever a blocked checkout needs a
    // decision: a dirty tree gets the force/stash choice, and a force that
    // still fails on untracked files escalates to a distinct deletion warning.
    // Any other error (or no error) leaves the prompt closed so the banner owns it.
    effect(() => {
      const error = this.repoState.checkoutError();
      const attempt = this.lastAttempt;
      // A pending pre-checkout confirmation owns the flow until the user acts;
      // never clobber it with a stale/previous checkout error. Read untracked so
      // writing `checkoutPrompt` below cannot re-trigger this effect.
      if (untracked(this.checkoutPrompt)?.mode === 'confirm') return;
      // An in-flight operation clears `checkoutError` at its start (and again in
      // `loadRefs`), which would tear the dirty/untracked dialog down mid-call.
      // Keep it open until the operation settles, then let the effect re-run and
      // close it on success. These reads are tracked so the settle re-triggers.
      if (!error && (this.repoState.checkoutRunning() || this.repoState.stashRunning())) return;
      if (!error || error.code !== 'CHECKOUT_FAILED' || !attempt) {
        this.checkoutPrompt.set(null);
        return;
      }
      const reason = error.details?.['reason'];
      if (reason === 'dirty_working_tree') {
        this.checkoutPrompt.set({
          name: attempt.name,
          isRemote: attempt.isRemote,
          mode: 'dirty',
        });
      } else if (reason === 'untracked_working_tree') {
        this.checkoutPrompt.set({
          name: attempt.name,
          isRemote: attempt.isRemote,
          mode: 'untracked',
        });
      } else {
        this.checkoutPrompt.set(null);
      }
    });

    // Native-menu navigation from the Electron main process; subscribe once and
    // unsubscribe on destroy.
    const unsubscribeMenu = this.bridge.onMenuNavigate((payload) => this.onMenuNavigate(payload));
    this.destroyRef.onDestroy(unsubscribeMenu);

    // Validated OS deep links (ADR-025); routed through the same root services.
    const unsubscribeDeepLink = this.bridge.onDeepLink((payload) => void this.onDeepLink(payload));
    this.destroyRef.onDestroy(unsubscribeDeepLink);

    // Ack deep-link readiness now that the `deeplink:open` subscription is in
    // place. The shell drains its FIFO queue on this signal, avoiding the
    // `did-finish-load` race where an initial link would be sent before this
    // subscription existed. A missing bridge/preload is a no-op (bounded
    // fallback in the shell still delivers).
    this.bridge.signalDeepLinkReady();
  }

  async ngOnInit(): Promise<void> {
    try {
      const pinned = localStorage.getItem(this.LS_DRAWER_PINNED);
      if (pinned !== null) this.drawerPinned.set(pinned === 'true');
    } catch {}

    // Restore the renderer-only workspace tabs before the core list arrives.
    this.workspaces.rehydrate();
    // Best-effort: publish persisted repositories so the drawer and rail can
    // resolve local repos and their refs.
    await this.repoState.loadRepositories();
    // Drop stale tab ids, then re-activate the restored tab so the shell and the
    // active-repo source of truth stay in sync across restarts (ADR-024).
    this.workspaces.reconcile(this.repoState.repos());
    const restoredTab = this.workspaces.activeTabId();
    if (restoredTab && this.repoState.activeId() === null) {
      this.workspaces.selectTab(restoredTab);
    }
    // Best-effort, non-blocking: connect the Git account once at startup.
    void this.githubAccount.autoConnectOnce();
  }

  // -- drawer interaction --------------------------------------------------

  /**
   * Pin toggle: from pinned, unpin and open the floating popover; from
   * unpinned, pin it back (which closes the popover).
   */
  onDrawerToggled(): void {
    if (this.drawerPinned()) {
      this.drawerPinned.set(false);
      this.drawerOpen.set(true);
    } else {
      this.drawerPinned.set(true);
      this.drawerOpen.set(false);
    }
  }

  /** Close the floating popover (only reachable while unpinned) and restore focus. */
  onDrawerClosed(): void {
    this.drawerOpen.set(false);
    if (typeof document !== 'undefined') {
      document.getElementById('st-drawer-toggle')?.focus();
    }
  }

  toggleRail(): void {
    this.railCollapsed.update((value) => !value);
  }

  /**
   * Navigate to a route requested by the OS-native menu. Empty or unknown
   * targets are ignored so a malformed payload cannot bounce the user.
   */
  onMenuNavigate(payload: MenuNavigatePayload): void {
    const route = payload?.route;
    if (typeof route !== 'string' || !LayoutComponent.MENU_ROUTES.has(route)) return;
    void this.router.navigateByUrl(route);
  }

  // -- deep links (ADR-025) ------------------------------------------------

  /**
   * Route a normalized deep link to existing per-repo flows. The shell already
   * validated the URL; this re-checks shapes defensively and never talks to Git
   * directly (all routing goes through `RepoState`/`IpcBridge`).
   */
  async onDeepLink(payload: DeepLinkPayload): Promise<void> {
    if (!payload || typeof payload.kind !== 'string') return;

    switch (payload.kind) {
      case 'open-path': {
        if (typeof payload.path !== 'string') return;
        const repo = await this.repoState.openRepositoryPath(payload.path);
        if (!repo) return;
        this.workspaces.openTab(repo);
        this.activeWorkspace.set('history');
        void this.router.navigate(['/repo']);
        return;
      }
      case 'open-commit': {
        if (typeof payload.repo !== 'string' || typeof payload.oid !== 'string') return;
        const repo = await this.resolveRepoWhenLoaded(payload.repo);
        if (!repo) return;
        this.workspaces.openTab(repo);
        this.workspaces.selectTab(repo.id);
        this.commitFocus.request(repo.id, payload.oid);
        this.activeWorkspace.set('history');
        void this.router.navigate(['/repo']);
        return;
      }
      case 'open-branch': {
        if (typeof payload.repo !== 'string' || typeof payload.branch !== 'string') return;
        const repo = await this.resolveRepoWhenLoaded(payload.repo);
        if (!repo) return;
        this.workspaces.openTab(repo);
        this.workspaces.selectTab(repo.id);
        this.activeWorkspace.set('history');
        void this.router.navigate(['/repo']);
        // Ensure the ref lists for the newly active repo are loaded before
        // resolving whether the branch is local or remote-tracking.
        await this.repoState.loadRefs();
        // Route through the same confirmation path as an interactive branch
        // click: a link must never silently switch a dirty working tree.
        const isRemote = this.repoState.remoteBranches().includes(payload.branch);
        if (isRemote) {
          this.onRemoteBranchSelected(payload.branch);
        } else {
          this.onBranchSelected(payload.branch);
        }
        return;
      }
      case 'clone': {
        if (typeof payload.url !== 'string' || !isPlausibleGitRemoteUrl(payload.url)) return;
        this.cloneDialog.set({ url: payload.url, error: null });
        return;
      }
    }
  }

  /**
   * Resolve a deep-link `<repo>` token against the persisted list: exact id,
   * then display name, then filesystem basename (most links use the name).
   */
  private resolveRepo(token: string): Repository | null {
    const repos = this.repoState.repos();
    return (
      repos.find((repo) => repo.id === token) ??
      repos.find((repo) => repo.name === token) ??
      repos.find((repo) => baseName(repo.fsPath) === token) ??
      null
    );
  }

  /**
   * Resolve a deep-link `<repo>` token, waiting for the first
   * `loadRepositories` to settle when it is still in flight.
   *
   * A link can arrive right after the renderer acknowledges readiness, before
   * `ngOnInit`'s `loadRepositories` has resolved, so an immediate miss is
   * retried once the repos-loaded signal fires.
   */
  private async resolveRepoWhenLoaded(token: string): Promise<Repository | null> {
    const immediate = this.resolveRepo(token);
    if (immediate) return immediate;
    await this.repoState.whenRepositoriesLoaded();
    return this.resolveRepo(token);
  }

  // -- clipboard clone (ADR-025) -------------------------------------------

  /**
   * Read a git URL from the clipboard and prefill the clone dialog. Invalid or
   * unavailable clipboard content opens the dialog with a validation message
   * instead of silently doing nothing.
   */
  async onCloneFromClipboard(): Promise<void> {
    const text = (await readClipboardText()).trim();
    if (!isPlausibleGitRemoteUrl(text)) {
      this.cloneDialog.set({
        url: '',
        error: $localize`The clipboard does not contain a Git URL.`,
      });
      return;
    }
    this.cloneDialog.set({ url: text, error: null });
  }

  /**
   * Copy the active repository's remote URL to the clipboard, falling back to a
   * shareable `singularitree://open?path=…` deep link when it has no remote.
   */
  async onCopyRepoUrl(): Promise<void> {
    const repo = this.repoState.activeRepo();
    if (!repo) return;
    await this.remoteOps.loadRefs();
    const remoteUrl = this.remoteOps.remoteOptions()[0]?.url ?? '';
    await copyToClipboard(remoteUrl || buildRepoDeepLink(repo.fsPath));
  }

  /** Close the clone dialog stub. */
  onCloneCancelled(): void {
    this.cloneDialog.set(null);
  }

  /**
   * Single-click lens request from the rail. The current local branch is never
   * lensed (its history already is the HEAD walk), so clicking it clears the
   * lens; every other ref toggles. The rail just emits and stays controlled.
   */
  onLensToggled(payload: { ref: string; kind: 'local' | 'remote' }): void {
    if (payload.kind === 'local' && payload.ref === this.repoState.currentBranch()) {
      this.lens.clear();
      return;
    }
    this.lens.toggle(payload.ref, payload.kind);
  }

  /** Open the pre-checkout confirmation for a local branch click. */
  onBranchSelected(name: string): void {
    // Checkout is the terminal "no lens" state: drop any view-only scope before
    // (even when the click targets the already-current branch).
    this.lens.clear();
    // Clicking the already-current local branch is a no-op beyond that.
    if (name === this.repoState.currentBranch()) return;
    this.checkoutPrompt.set({ name, isRemote: false, mode: 'confirm' });
  }

  /** Open the pre-checkout confirmation for a remote-tracking branch click. */
  onRemoteBranchSelected(name: string): void {
    // A checkout always lands lens-free.
    this.lens.clear();
    this.checkoutPrompt.set({ name, isRemote: true, mode: 'confirm' });
  }

  // -- ref mutation entry points (ADR-028) ---------------------------------

  /** "+" in the BRANCHES header: open the create-branch dialog at the current ref. */
  onNewBranchRequested(): void {
    this.repoState.clearRefOpError();
    this.branchDialog.set({ startPoint: this.repoState.currentBranch() || 'HEAD' });
  }

  onCreateBranchSubmitted(value: BranchCreateValue): void {
    void this.repoState.createBranch(value.name, value.startPoint, value.checkout).then((ok) => {
      if (ok) this.branchDialog.set(null);
    });
  }

  onBranchDialogCancelled(): void {
    this.branchDialog.set(null);
    this.repoState.clearRefOpError();
  }

  onBranchRenameRequested(name: string): void {
    this.repoState.clearRefOpError();
    this.renameDialog.set(name);
  }

  onRenameSubmitted(newName: string): void {
    const oldName = this.renameDialog();
    if (!oldName) return;
    void this.repoState.renameBranch(oldName, newName).then((ok) => {
      if (ok) this.renameDialog.set(null);
    });
  }

  onRenameCancelled(): void {
    this.renameDialog.set(null);
    this.repoState.clearRefOpError();
  }

  onBranchDeleteRequested(name: string): void {
    this.repoState.clearRefOpError();
    this.deleteDialog.set({ kind: 'branch', name });
  }

  onTagDeleteRequested(name: string): void {
    this.repoState.clearRefOpError();
    this.deleteDialog.set({ kind: 'tag', name });
  }

  onDeleteConfirmed(force: boolean): void {
    const target = this.deleteDialog();
    if (!target) return;
    const op =
      target.kind === 'branch'
        ? this.repoState.deleteBranch(target.name, force)
        : this.repoState.deleteTag(target.name);
    void op.then((ok) => {
      if (ok) this.deleteDialog.set(null);
    });
  }

  onDeleteCancelled(): void {
    this.deleteDialog.set(null);
    this.repoState.clearRefOpError();
  }

  /** "+" in the TAGS header: open the create-tag dialog at HEAD. */
  onNewTagRequested(): void {
    this.repoState.clearRefOpError();
    this.tagDialog.set({ target: 'HEAD' });
  }

  onTagCreateSubmitted(value: TagCreateValue): void {
    void this.repoState
      .createTag(value.name, value.target, value.annotated, value.message, value.force)
      .then((ok) => {
        if (ok) this.tagDialog.set(null);
      });
  }

  onTagDialogCancelled(): void {
    this.tagDialog.set(null);
    this.repoState.clearRefOpError();
  }

  onBranchMergeRequested(name: string): void {
    this.repoState.clearRefOpError();
    this.mergeDialog.set(name);
  }

  onMergeSubmitted(value: MergeValue): void {
    void this.repoState
      .merge(value.ref, value.strategy, value.noCommit, value.message)
      .then((ok) => {
        if (ok) this.mergeDialog.set(null);
      });
  }

  onMergeCancelled(): void {
    this.mergeDialog.set(null);
    this.repoState.clearRefOpError();
  }

  // -- cherry-pick (ADR-0042) ----------------------------------------------

  /**
   * Cherry-pick the dialog's source onto the current branch. The dialog stays
   * open when the pick conflicts (`false`), so its warn row and the refreshed
   * working tree are visible next to the source it applies to.
   */
  onCherryPickSubmitted(value: CherryPickValue): void {
    void this.repoState
      .cherryPick(value.source, value.recordOrigin, value.noCommit)
      .then((ok) => {
        if (ok) this.repoState.closeCherryPick();
      });
  }

  /** Preview the settled source revision (the dialog debounces the typing). */
  onCherrySourceChange(source: string): void {
    void this.repoState.resolveCherryPickSource(source);
  }

  onCherryPickCancelled(): void {
    this.repoState.closeCherryPick();
    this.repoState.clearRefOpError();
  }

  // -- stash entry points (ADR-028) ----------------------------------------

  /** "+" in the STASHES header: open the stash-current-changes dialog. */
  onStashPushRequested(): void {
    this.repoState.clearStashOpError();
    this.stashPushDialog.set(true);
  }

  onStashPushSubmitted(message: string): void {
    void this.repoState.stashPush(message).then((ok) => {
      if (ok) this.stashPushDialog.set(false);
    });
  }

  onStashPushCancelled(): void {
    this.stashPushDialog.set(false);
    this.repoState.clearStashOpError();
  }

  onStashApplyRequested(stash: Stash): void {
    this.repoState.clearStashOpError();
    void this.repoState.stashApply(stash.index, false);
  }

  onStashPopRequested(stash: Stash): void {
    this.repoState.clearStashOpError();
    void this.repoState.stashPop(stash.index);
  }

  onStashDropRequested(stash: Stash): void {
    this.repoState.clearStashOpError();
    this.stashDropDialog.set(stash);
  }

  onStashDropConfirmed(): void {
    const stash = this.stashDropDialog();
    if (!stash) return;
    void this.repoState.stashDrop(stash.index).then((ok) => {
      if (ok) this.stashDropDialog.set(null);
    });
  }

  onStashDropCancelled(): void {
    this.stashDropDialog.set(null);
    this.repoState.clearStashOpError();
  }

  // -- git-flow entry points (ADR-027) -------------------------------------

  /** GIT FLOW header: open the git-flow panel on its Start tab and load config. */
  onGitFlowRequested(): void {
    this.repoState.clearGitFlowError();
    this.repoState.dismissGitFlowResult();
    void this.repoState.loadGitFlowConfig();
    this.gitFlowDialog.set('start');
  }

  onGitFlowStartSubmitted(value: GitFlowStartValue): void {
    void this.repoState.startGitFlow(value.kind, value.name, value.base).then((ok) => {
      if (ok) this.gitFlowDialog.set(null);
    });
  }

  /**
   * Finish a workflow. The dialog stays open on success so the returned `steps`
   * (and any conflict notice) are visible; the user closes it.
   */
  onGitFlowFinishSubmitted(value: GitFlowFinishValue): void {
    void this.repoState.finishGitFlow(value.kind, value.name, value.deleteBranch);
  }

  onGitFlowConfigSubmitted(config: GitFlowConfig): void {
    void this.repoState.saveGitFlowConfig(config).then((ok) => {
      if (ok) this.gitFlowDialog.set(null);
    });
  }

  onGitFlowCancelled(): void {
    this.gitFlowDialog.set(null);
    this.repoState.clearGitFlowError();
    this.repoState.dismissGitFlowResult();
  }

  /**
   * User confirmed the pre-checkout dialog: retry the target with the force flag
   * they chose. A plain (unforced) checkout that is blocked by a dirty tree falls
   * through to the existing dirty save/force/cancel dialog via `checkoutError`.
   */
  onConfirmed(force: boolean): void {
    const prompt = this.checkoutPrompt();
    if (!prompt) return;
    this.lastAttempt = { name: prompt.name, isRemote: prompt.isRemote };
    this.checkoutPrompt.set(null);
    void this.repoState.checkoutBranch(prompt.name, prompt.isRemote, force, false);
  }

  /**
   * Force the pending checkout: discard tracked changes, and in untracked mode
   * also clean untracked files (never silently — the modal gated it).
   */
  onForceCheckout(): void {
    const prompt = this.checkoutPrompt();
    if (!prompt) return;
    const discardUntracked = prompt.mode === 'untracked';
    void this.repoState.checkoutBranch(prompt.name, prompt.isRemote, true, discardUntracked);
  }

  /** Stash the blocking changes, then retry the checkout without force. */
  onSaveChanges(): void {
    const prompt = this.checkoutPrompt();
    if (!prompt) return;
    void this.stashAndRetryCheckout(prompt);
  }

  private async stashAndRetryCheckout(prompt: CheckoutPrompt): Promise<void> {
    const stashed = await this.repoState.stashPush(
      `Auto-stash before switching to '${prompt.name}'`,
    );
    if (!stashed) return;
    await this.repoState.checkoutBranch(prompt.name, prompt.isRemote, false, false);
  }

  /**
   * Dismiss the prompt without changing any state. Cancelling the pre-checkout
   * `confirm` dialog aborts before any checkout was attempted, so it must not
   * dismiss a pre-existing checkout error; only cancelling a dirty/untracked
   * conflict clears the error that opened it.
   */
  onCancelCheckoutPrompt(): void {
    const prompt = this.checkoutPrompt();
    this.checkoutPrompt.set(null);
    if (prompt?.mode === 'dirty' || prompt?.mode === 'untracked') {
      this.repoState.dismissCheckoutError();
    }
  }

  /** Activate (and register) the local repository picked in the drawer. */
  onRepoSelected(id: string): void {
    const repo = this.repoState.repos().find((r) => r.id === id);
    if (repo) {
      this.workspaces.openTab(repo);
      this.repoState.setActive(repo);
    }
  }

  /** Remove a repository from the persisted list via the drawer's trash icon. */
  onRemoveRepository(id: string): void {
    void this.repoState.removeRepository(id).then((ok) => {
      if (ok) {
        this.remoteOps.invalidateFetch(id);
        this.workspaces.closeTab(id);
      }
    });
  }

  /** Route to the repository manager when the drawer's add button is used. */
  onAddRepository(): void {
    void this.router.navigate(['/repos']);
  }

  // -- repo tabs / workspaces (ADR-024) ------------------------------------

  /** Activate a repo tab and route to its graph. */
  onTabSelected(id: string): void {
    this.workspaces.selectTab(id);
    void this.router.navigate(['/repo']);
  }

  /**
   * Rail WORKSPACE selection (ADR-024 tabs, ADR-0029 file status). History is
   * the routed repository screen and File status is a routed child of it, so
   * both render through the shared `router-outlet`; Repositories routes out to
   * the repository manager.
   */
  onWorkspaceSelected(kind: string): void {
    this.activeWorkspace.set(kind);
    if (kind === 'status') {
      void this.router.navigate(['/repo', 'file-status']);
      return;
    }
    if (kind === 'history') {
      void this.router.navigate(['/repo']);
      return;
    }
    if (kind === 'repos') {
      void this.router.navigate(['/repos']);
    }
  }

  /**
   * Close a repo tab. Closing the active tab selects a neighbour; with no tabs
   * left the shell falls back to the repository manager.
   */
  onTabClosed(id: string): void {
    // Kill any in-flight fetch for the closed repository first: its late result
    // must never write the status line or refresh another repository's refs.
    this.remoteOps.invalidateFetch(id);
    const wasActive = this.workspaces.activeTabId() === id;
    this.workspaces.closeTab(id);
    if (wasActive) {
      void this.router.navigate(this.workspaces.activeTabId() ? ['/repo'] : ['/repos']);
    }
  }

  /** "+" in the top bar: route to the repository manager to open another repo. */
  onTabAdd(): void {
    void this.router.navigate(['/repos']);
  }

  // -- active-tab sync (ADR-024) -------------------------------------------

  /**
   * Sync the active tab: fetch ONLY the currently visible repository. An
   * explicit user action bypasses the lazy freshness marker (`fetchRepo`, not
   * `fetchRepoIfStale`) but still runs fire-and-forget. No active tab is a
   * no-op.
   */
  onSync(): void {
    const id = this.workspaces.activeTabId();
    if (!id) return;
    void this.remoteOps.fetchRepo(id, { force: true });
  }
}
