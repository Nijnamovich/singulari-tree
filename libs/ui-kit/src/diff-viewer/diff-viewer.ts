import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { Diff } from '@contracts/domain';
import { ButtonComponent } from '../button/button';
import { IconComponent } from '../icon/icon';
import { diffToGridRows, hunkGridSegments, hunksToTexts, type HunkLineSegment } from './hunks-to-texts';
import { singularitreeThemeName } from './monaco-theme';

type MonacoDiffEditor = import('monaco-editor').editor.IStandaloneDiffEditor;
type MonacoTextModel = import('monaco-editor').editor.ITextModel;

/** The Monaco namespace, kept structural so tests can inject a fake module. */
export type MonacoModule = typeof import('monaco-editor');

/** Lazily loads the Monaco module; replaceable in tests to avoid booting it. */
export type MonacoLoader = () => Promise<MonacoModule>;

/** Pure inputs that decide whether Monaco may mount. */
export interface MonacoDecisionState {
  readonly loading: boolean;
  readonly error: boolean;
  readonly isBinary: boolean;
  readonly hasConflict: boolean;
  readonly isEmpty: boolean;
}

/**
 * Pure decision helper (no DOM/Monaco): Monaco is mounted only for a real,
 * textual, conflict-free, non-empty, non-loading, error-free diff. Kept pure so
 * the mount policy is unit-testable in isolation.
 */
export function shouldInitializeMonaco(state: MonacoDecisionState): boolean {
  return !state.loading && !state.error && !state.isBinary && !state.hasConflict && !state.isEmpty;
}

/**
 * True when a real browser worker environment exists. jsdom (unit tests) has no
 * `Worker`, so Monaco is never initialized there and the plain fallback is used.
 */
export function monacoEnvironmentAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Code grid line height: exactly 2× the font size. The Settings presets are
 * 11→22, 12→24 (the shipped pair) and 13→26, so the mono code stays on a 2×
 * grid in both the Monaco editor and the CSS fallback.
 */
export function diffLineHeight(fontSize: number): number {
  return fontSize * 2;
}

/** One host-supplied action button rendered on a hunk's header row. */
export interface HunkActionSpec {
  /** Host-defined action id, e.g. `'stage' | 'discard'` (echoed on `hunkAction`). */
  readonly key: string;
  /** ui-kit icon registry key (`'plus'`, `'discard'`, …). */
  readonly icon: string;
  /** Accessible name, host-localized (the viewer adds no label of its own). */
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * The per-hunk affordance the host supplies to the viewer. `hunkIndex` is the
 * index into `diff().hunks`, which the inline surface maps 1:1 to the
 * `hunk_index` the core's per-hunk RPCs address; `selectedLines` are 0-based
 * indices into `hunk.lines`, echoed back through `hunkLineToggle`.
 */
export interface HunkActionSlot {
  /** Index into `diff().hunks` — the stable mapping to the RPC's `hunk_index`. */
  readonly hunkIndex: number;
  /** Buttons rendered on that hunk's header row. */
  readonly actions: readonly HunkActionSpec[];
  /** 0-based indices into `hunk.lines` that are checked. */
  readonly selectedLines: readonly number[];
}

/**
 * Environment probe used before the dynamic import. The default checks the
 * browser worker environment; tests override it to exercise the init path in
 * jsdom without booting Monaco.
 */
export const MONACO_ENVIRONMENT_AVAILABLE = new InjectionToken<() => boolean>(
  'MONACO_ENVIRONMENT_AVAILABLE',
  { providedIn: 'root', factory: () => monacoEnvironmentAvailable },
);

/**
 * Lazy Monaco loader. The default dynamic-imports the worker-configured module
 * (kept out of the initial bundle); tests override it with a fake module.
 */
export const MONACO_LOADER = new InjectionToken<MonacoLoader>('MONACO_LOADER', {
  providedIn: 'root',
  factory: () => () => import('./monaco-loader').then((module) => module.loadMonaco()),
});

/**
 * Read-only diff viewer. Renders a lazily-loaded Monaco `DiffEditor` when
 * possible and a 4-column grid fallback otherwise (before the chunk
 * loads, in tests, or if initialization fails). Binary/conflicted/empty diffs
 * short-circuit to distinct messages.
 *
 * Monaco initialization is reactive: in the real flow (`StatusStore`) the diff
 * arrives asynchronously, so a single post-render attempt is not enough. An
 * effect keyed on the diff + guards + container query mounts the editor as soon
 * as a real diff is available (idempotent, no-op when already mounted).
 *
 * The `fontSize` (11 | 12 | 13) and `wordWrap` inputs are pure pass-throughs of
 * the persisted diff preferences; the host app reads them from `PreferencesService`
 * and binds them here (this dumb component never reads preferences itself). Both
 * drive the Monaco editor and the fallback grid live, and the code line height is
 * always exactly 2× the font size (see `diffLineHeight`).
 *
 * When the host supplies `hunkActions` the viewer switches to an inline-action
 * surface: per-hunk action buttons and per-line checkboxes rendered in its own
 * 5-column tokenized grid (Monaco never mounts), emitting `hunkAction` /
 * `hunkLineToggle` addressed by `hunkIndex` / `lineIndex`. Every read-only
 * consumer (commit/PR variants, History) passes no actions and keeps Monaco.
 */
@Component({
  selector: 'st-diff-viewer',
  imports: [ButtonComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'diff-viewer' },
  template: `
    @if (truncated()) {
      <p
        class="st-diff-viewer__notice st-diff-viewer__notice--truncated"
        data-testid="diff-truncated"
        i18n
      >
        Diff truncated — some changes are not shown.
      </p>
    }
    @if (errorMsg(); as message) {
      <p class="st-diff-viewer__notice st-diff-viewer__notice--error" data-testid="diff-error">
        {{ message }}
      </p>
    } @else if (loading()) {
      <p class="st-diff-viewer__notice" data-testid="diff-loading" i18n>Loading diff…</p>
    } @else if (isBinary()) {
      <p class="st-diff-viewer__notice" data-testid="diff-binary" i18n>Binary file — no textual diff.</p>
    } @else if (hasConflict()) {
      <p class="st-diff-viewer__notice" data-testid="diff-conflict" i18n>
        Merge conflict markers detected.
      </p>
    } @else if (isEmpty()) {
      <p class="st-diff-viewer__notice" data-testid="diff-empty" i18n>No changes to display.</p>
    } @else {
      @if (hunkActions() !== null) {
        <!--
          Inline-action surface. When the host supplies per-hunk actions the
          viewer owns this 5-column grid (checkbox | old-num | new-num | sign |
          text) instead of Monaco, so per-hunk buttons and per-line checkboxes
          live in one consistent, unit-testable surface. Monaco never mounts in
          this state — read-only consumers without the action input keep the
          Monaco editor unchanged.
        -->
        <div
          class="st-diff-viewer__fallback st-diff-viewer__fallback--actions"
          data-testid="diff-fallback"
          [attr.data-wrap]="wordWrap() ? 'on' : 'off'"
          [style.font-size.px]="fontSize()"
          [style.line-height.px]="diffLineHeight(fontSize())"
        >
          @for (row of fallbackRows(); track $index; let rowIndex = $index) {
            @if (row.kind === 'hunk') {
              <div
                class="st-diff-viewer__fallback-hunk st-diff-viewer__fallback-hunk--actions st-tabular-nums"
                data-testid="diff-fallback-hunk"
              >
                <span class="st-diff-viewer__gcheck"></span>
                <span class="st-diff-viewer__gnum"></span>
                <span class="st-diff-viewer__gnum"></span>
                <span class="st-diff-viewer__gsign"></span>
                <span class="st-diff-viewer__gtext st-diff-viewer__hunk-header">
                  <span class="st-diff-viewer__hunk-range">{{ row.text }}</span>
                  <span class="st-diff-viewer__hunk-actions">
                    @for (action of actionsForRow(rowIndex); track action.key) {
                      <st-button
                        variant="icon"
                        size="sm"
                        data-testid="diff-hunk-action"
                        [attr.data-action]="action.key"
                        [ariaLabel]="action.label"
                        [disabled]="action.disabled ?? false"
                        (click)="onHunkAction(rowIndex, action.key)"
                      >
                        <st-icon [name]="action.icon"></st-icon>
                      </st-button>
                    }
                  </span>
                </span>
              </div>
            } @else if (row.kind === 'meta') {
              <div
                class="st-diff-viewer__fallback-hunk st-diff-viewer__fallback-hunk--actions st-tabular-nums"
                data-testid="diff-fallback-hunk"
              >
                <span class="st-diff-viewer__gcheck"></span>
                <span class="st-diff-viewer__gnum"></span>
                <span class="st-diff-viewer__gnum"></span>
                <span class="st-diff-viewer__gsign"></span>
                <span class="st-diff-viewer__gtext">{{ row.text }}</span>
              </div>
            } @else {
              <div
                class="st-diff-viewer__fallback-row st-diff-viewer__fallback-row--actions"
                [attr.data-kind]="row.kind"
              >
                <span class="st-diff-viewer__gcheck">
                  @if (lineMeta(rowIndex); as line) {
                    <input
                      type="checkbox"
                      class="st-diff-viewer__gcheck-input"
                      data-testid="diff-hunk-line"
                      [attr.data-line]="line.lineIndex"
                      [attr.aria-label]="lineCheckboxLabel"
                      [checked]="isLineChecked(line.hunkIndex, line.lineIndex)"
                      (change)="onHunkLineToggle(line.hunkIndex, line.lineIndex)"
                    />
                  }
                </span>
                <span class="st-diff-viewer__gnum st-tabular-nums">{{ row.oldNum ?? '' }}</span>
                <span class="st-diff-viewer__gnum st-tabular-nums">{{ row.newNum ?? '' }}</span>
                <span class="st-diff-viewer__gsign">{{ row.sign }}</span>
                <span class="st-diff-viewer__gtext">{{ row.text }}</span>
              </div>
            }
          }
        </div>
      } @else {
        <div class="st-diff-viewer__editor" #container></div>
        @if (!monacoReady()) {
          <div
            class="st-diff-viewer__fallback"
            data-testid="diff-fallback"
            [attr.data-wrap]="wordWrap() ? 'on' : 'off'"
            [style.font-size.px]="fontSize()"
            [style.line-height.px]="diffLineHeight(fontSize())"
          >
            @for (row of fallbackRows(); track $index) {
              @if (row.kind === 'hunk' || row.kind === 'meta') {
                <div
                  class="st-diff-viewer__fallback-hunk st-tabular-nums"
                  data-testid="diff-fallback-hunk"
                >
                  {{ row.text }}
                </div>
              } @else {
                <div class="st-diff-viewer__fallback-row" [attr.data-kind]="row.kind">
                  <span class="st-diff-viewer__gnum st-tabular-nums">{{ row.oldNum ?? '' }}</span>
                  <span class="st-diff-viewer__gnum st-tabular-nums">{{ row.newNum ?? '' }}</span>
                  <span class="st-diff-viewer__gsign">{{ row.sign }}</span>
                  <span class="st-diff-viewer__gtext">{{ row.text }}</span>
                </div>
              }
            }
          </div>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      overflow: auto;
      color: var(--st-color-text);
    }

    .st-diff-viewer__notice {
      margin: 0;
      padding: var(--st-space-3);
      font-size: var(--st-font-12);
      opacity: 0.65;
    }

    .st-diff-viewer__notice--error {
      color: var(--st-color-danger);
      opacity: 1;
    }

    .st-diff-viewer__notice--truncated {
      color: var(--st-color-warn);
      opacity: 1;
      border-bottom: var(--st-hairline) solid
        color-mix(in srgb, var(--st-color-warn) 40%, transparent);
    }

    .st-diff-viewer__editor {
      height: 100%;
      min-height: 160px;
    }

    .st-diff-viewer__fallback {
      font-family: var(--st-font-mono);
      font-size: var(--st-font-12);
      line-height: var(--st-leading-code);
      overflow: auto;
    }

    .st-diff-viewer__fallback-row {
      display: grid;
      grid-template-columns: 36px 36px 20px 1fr;
    }

    .st-diff-viewer__fallback-hunk {
      background: var(--st-color-diff-hunk-bg);
      color: var(--st-color-diff-hunk-fg);
      padding: 0 var(--st-space-2);
      font-size: var(--st-font-11);
    }

    /* Inline-action surface: line rows and the hunk header share ONE 5-column
       grid (checkbox | old-num | new-num | sign | text), so the per-hunk buttons
       on the header row line up with the per-line checkboxes below them. */
    .st-diff-viewer__fallback--actions .st-diff-viewer__fallback-row,
    .st-diff-viewer__fallback--actions .st-diff-viewer__fallback-hunk--actions {
      display: grid;
      grid-template-columns: 28px 36px 36px 20px minmax(0, 1fr);
      align-items: center;
    }

    /* The header carries no padding of its own: its range text must start in the
       same code column as the line text below it. */
    .st-diff-viewer__fallback--actions .st-diff-viewer__fallback-hunk--actions {
      padding: 0;
    }

    .st-diff-viewer__gcheck {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .st-diff-viewer__gcheck-input {
      margin: 0;
      cursor: pointer;
    }

    /* Range text left, buttons right, inside the shared text column. */
    .st-diff-viewer__hunk-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--st-space-2);
      min-width: 0;
    }

    .st-diff-viewer__hunk-actions {
      display: flex;
      align-items: center;
      gap: var(--st-space-1);
      flex: none;
      margin-left: auto;
    }

    .st-diff-viewer__gnum {
      color: var(--st-color-diff-gutter-fg);
      text-align: right;
      padding: 0 var(--st-space-1) 0 var(--st-space-2);
    }

    .st-diff-viewer__gsign {
      text-align: center;
    }

    /* Wrap contract: the container carries a data-wrap attribute; 'on'
       soft-wraps long lines inside the code column, 'off' keeps
       white-space: pre and lets the row's last grid track grow to max-content
       so long lines overflow and scroll horizontally (the host already has
       overflow: auto). */
    .st-diff-viewer__fallback[data-wrap='on'] .st-diff-viewer__gtext {
      white-space: pre-wrap;
      word-break: break-all;
    }

    .st-diff-viewer__fallback[data-wrap='off'] .st-diff-viewer__gtext {
      white-space: pre;
      word-break: normal;
    }

    .st-diff-viewer__fallback[data-wrap='off'] .st-diff-viewer__fallback-row {
      /* The last track grows to max-content so long lines overflow and scroll
         horizontally; the row box must grow with it (min-width keeps it full
         width for short lines) or the add/remove tints would paint only the
         border box and vanish as soon as the reader scrolls right. */
      grid-template-columns: 36px 36px 20px max-content;
      width: max-content;
      min-width: 100%;
    }

    /* Same wrap contract on the 5-column inline-action surface. */
    .st-diff-viewer__fallback--actions[data-wrap='off'] .st-diff-viewer__fallback-row,
    .st-diff-viewer__fallback--actions[data-wrap='off'] .st-diff-viewer__fallback-hunk--actions {
      grid-template-columns: 28px 36px 36px 20px max-content;
      width: max-content;
      min-width: 100%;
    }

    .st-diff-viewer__fallback-row[data-kind='added'] {
      background: var(--st-color-diff-insert-bg);
      color: var(--st-color-diff-insert-fg);
    }

    .st-diff-viewer__fallback-row[data-kind='removed'] {
      background: var(--st-color-diff-delete-bg);
      color: var(--st-color-diff-delete-fg);
    }
  `,
})
export class DiffViewer {
  readonly diff = input<Diff | null>(null);
  readonly loading = input(false);
  readonly errorMsg = input<string | null>(null);
  /** True when the core capped the diff (ADR-0020 (c)); renders a notice. */
  readonly truncated = input(false);
  /**
   * Side-by-side vs unified layout. Unified is the shipped default (plan §4.6);
   * the Settings toggle flips it live.
   */
  readonly renderSideBySide = input(false);
  /** Diff code font size in CSS pixels (Settings: 11 | 12 | 13). Default 12. */
  readonly fontSize = input(12);
  /** Diff soft wrap (Settings on/off). Default false. */
  readonly wordWrap = input(false);
  /**
   * Host-supplied per-hunk actions. `null` (the default) keeps the viewer a
   * Monaco read-only surface for every read-only consumer (commit/PR variants,
   * History). When non-null the viewer renders its OWN 5-column tokenized grid
   * — per-hunk buttons on the header rows and a checkbox on every changed line —
   * and Monaco never mounts, so the inline affordances live in one consistent,
   * unit-testable surface instead of hacking the editor's DOM.
   */
  readonly hunkActions = input<readonly HunkActionSlot[] | null>(null);
  /** A hunk action button was clicked; the host maps the key back to its RPC. */
  readonly hunkAction = output<{ hunkIndex: number; actionKey: string }>();
  /** A changed-line checkbox was toggled. */
  readonly hunkLineToggle = output<{ hunkIndex: number; lineIndex: number }>();

  /** Accessible name for a changed-line checkbox (the label is viewer-owned). */
  protected readonly lineCheckboxLabel = $localize`Select changed line`;

  /** Exposed to the template for the fallback grid's inline line height (2×). */
  protected readonly diffLineHeight = diffLineHeight;

  private readonly loader = inject(MONACO_LOADER);
  private readonly environmentAvailable = inject(MONACO_ENVIRONMENT_AVAILABLE);
  private readonly destroyRef = inject(DestroyRef);

  private readonly container = viewChild<ElementRef<HTMLElement>>('container');
  private editor: MonacoDiffEditor | null = null;
  private originalModel: MonacoTextModel | null = null;
  private modifiedModel: MonacoTextModel | null = null;
  /** DOM node the current editor is attached to (detects container replacement). */
  private mountedContainer: HTMLElement | null = null;
  /** Guards against overlapping lazy-load attempts. */
  private initializing = false;

  /** True once the Monaco editor is mounted (fallback hidden). */
  protected readonly monacoReady = signal(false);

  protected readonly texts = computed(() => hunksToTexts(this.diff()));
  /** Rows for the non-Monaco 4-column grid fallback. */
  protected readonly fallbackRows = computed(() => diffToGridRows(this.diff()));
  protected readonly isBinary = computed(() => this.diff()?.isBinary === true);
  protected readonly hasConflict = computed(() => this.diff()?.hasConflictMarkers === true);
  protected readonly isEmpty = computed(() => {
    const diff = this.diff();
    if (!diff) return true;
    if (diff.isBinary || diff.hasConflictMarkers) return false;
    return (diff.hunks?.length ?? 0) === 0;
  });

  /**
   * Per-hunk render anchors, derived from the SAME walk that produces
   * `fallbackRows` (never a second diff computation): each rendered hunk's
   * header row and the changed lines' `(rowIndex, lineIndex)` pairs. This is the
   * single mapping from a rendered row to the `hunk_index`/`line_indices` the
   * host's per-hunk RPCs address.
   */
  private readonly actionSegments = computed(() => hunkGridSegments(this.diff()));

  /** Header row index → hunk index. */
  private readonly hunkIndexByHeaderRow = computed(() => {
    const map = new Map<number, number>();
    for (const segment of this.actionSegments()) {
      map.set(segment.headerRowIndex, segment.hunkIndex);
    }
    return map;
  });

  /** Changed line row index → `{ hunkIndex, lineIndex }`. */
  private readonly changedLineByRow = computed(() => {
    const map = new Map<number, HunkLineSegment & { hunkIndex: number }>();
    for (const segment of this.actionSegments()) {
      for (const line of segment.lines) {
        map.set(line.rowIndex, { ...line, hunkIndex: segment.hunkIndex });
      }
    }
    return map;
  });

  /** Action buttons rendered on the hunk whose header row is `rowIndex`. */
  protected actionsForRow(rowIndex: number): readonly HunkActionSpec[] {
    const hunkIndex = this.hunkIndexByHeaderRow().get(rowIndex);
    if (hunkIndex === undefined) return [];
    return this.hunkActions()?.find((slot) => slot.hunkIndex === hunkIndex)?.actions ?? [];
  }

  /** Changed-line address for a rendered row, or `null` for context/header rows. */
  protected lineMeta(rowIndex: number): (HunkLineSegment & { hunkIndex: number }) | null {
    return this.changedLineByRow().get(rowIndex) ?? null;
  }

  protected isLineChecked(hunkIndex: number, lineIndex: number): boolean {
    const slot = this.hunkActions()?.find((candidate) => candidate.hunkIndex === hunkIndex);
    return slot?.selectedLines.includes(lineIndex) ?? false;
  }

  /** Emit the clicked action addressed by its hunk index (not the row index). */
  protected onHunkAction(rowIndex: number, actionKey: string): void {
    const hunkIndex = this.hunkIndexByHeaderRow().get(rowIndex);
    if (hunkIndex === undefined) return;
    this.hunkAction.emit({ hunkIndex, actionKey });
  }

  protected onHunkLineToggle(hunkIndex: number, lineIndex: number): void {
    this.hunkLineToggle.emit({ hunkIndex, lineIndex });
  }

  constructor() {
    // Keep the Monaco models in sync when the diff input changes post-init.
    effect(() => {
      const { original, modified } = this.texts();
      if (this.originalModel && this.originalModel.getValue() !== original) {
        this.originalModel.setValue(original);
      }
      if (this.modifiedModel && this.modifiedModel.getValue() !== modified) {
        this.modifiedModel.setValue(modified);
      }
    });

    // Reactive init: the diff may arrive asynchronously, so track the diff, the
    // loading/error guards and the container query; any change re-evaluates
    // `maybeInitializeMonaco` (idempotent, no-op when already mounted).
    effect(() => {
      void this.maybeInitializeMonaco();
    });

    // Live layout toggle: keep a mounted editor in sync when `renderSideBySide`
    // changes (no-op on init, when the editor is still null). The input is read
    // unconditionally so the effect tracks it even before the editor mounts.
    effect(() => {
      const renderSideBySide = this.renderSideBySide();
      this.editor?.updateOptions({ renderSideBySide });
    });

    // Live typography/wrap: keep a mounted editor in sync when `fontSize` or
    // `wordWrap` change (no-op on init, when the editor is still null). Both
    // inputs are read unconditionally so the effect tracks them even before the
    // editor mounts. Options go through `updateOptions` only — never a remount,
    // so the change applies without a flash.
    effect(() => {
      const fontSize = this.fontSize();
      const wordWrap = this.wordWrap();
      this.editor?.updateOptions({
        fontSize,
        lineHeight: diffLineHeight(fontSize),
        wordWrap: wordWrap ? 'on' : 'off',
      });
    });

    // Safety net for the first render (`#container` present on the first pass).
    afterNextRender(() => {
      void this.maybeInitializeMonaco();
    });

    this.destroyRef.onDestroy(() => this.disposeMonaco());
  }

  private shouldInitialize(): boolean {
    // The inline-action surface replaces Monaco entirely: when the host supplies
    // per-hunk actions the viewer owns the grid (buttons + line checkboxes), so
    // Monaco must never mount even in a real browser environment.
    if (this.hunkActions() !== null) return false;
    return shouldInitializeMonaco({
      loading: this.loading(),
      error: this.errorMsg() !== null,
      isBinary: this.isBinary(),
      hasConflict: this.hasConflict(),
      isEmpty: this.isEmpty(),
    });
  }

  /**
   * Mount Monaco when a real diff is present and the environment supports it.
   * Idempotent: no-op while a load is in flight or when the editor is already
   * attached to the current container. Rebuilds if the container was replaced
   * (e.g. the diff briefly disappeared and the `@else` block re-rendered).
   */
  private async maybeInitializeMonaco(): Promise<void> {
    // Actions appearing after Monaco mounted must tear the editor down: the
    // inline surface takes over the container slot. `hunkActions` is read here
    // (and in `shouldInitialize`) so the effect tracks it.
    if (this.hunkActions() !== null) {
      this.disposeEditor();
      return;
    }
    // Read all reactive inputs synchronously so the effect tracks them.
    const canMount = this.shouldInitialize();
    const container = this.container()?.nativeElement ?? null;
    if (!canMount || !container) return;
    // Never touch the dynamic import when there is no worker environment.
    if (!this.environmentAvailable()) return;
    // Already mounted here: the model-sync effect keeps the content fresh.
    if (this.editor && this.mountedContainer === container) return;
    if (this.initializing) return;

    if (this.editor) this.disposeEditor();

    this.initializing = true;
    try {
      const monaco = await this.loader();
      // State may have changed while the chunk loaded: re-validate before
      // touching the DOM, and discard a stale load.
      if (!this.shouldInitialize() || this.container()?.nativeElement !== container) return;

      // Apply the token-derived theme for the current appearance before the
      // editor mounts, so it never flashes the default theme.
      monaco.editor.setTheme(
        singularitreeThemeName(document.documentElement.getAttribute('data-theme')),
      );

      const { original, modified } = this.texts();
      this.originalModel = monaco.editor.createModel(original, 'plaintext');
      this.modifiedModel = monaco.editor.createModel(modified, 'plaintext');
      this.editor = monaco.editor.createDiffEditor(container, {
        readOnly: true,
        originalEditable: false,
        renderSideBySide: this.renderSideBySide(),
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        // Mono font family mirrors `--st-font-mono`; the font size comes from the
        // persisted preference (Settings: 11 | 12 | 13) and the code grid line
        // height is exactly 2× that value (11→22, 12→24, 13→26, matching the CSS
        // fallback's `--st-leading-code`), so both surfaces stay aligned.
        fontFamily: "Consolas, 'Liberation Mono', ui-monospace, monospace",
        fontSize: this.fontSize(),
        lineHeight: diffLineHeight(this.fontSize()),
        wordWrap: this.wordWrap() ? 'on' : 'off',
      });
      this.editor.setModel({ original: this.originalModel, modified: this.modifiedModel });
      this.mountedContainer = container;
      this.monacoReady.set(true);
    } catch {
      // Initialization failed: keep the grid fallback visible.
      this.monacoReady.set(false);
    } finally {
      this.initializing = false;
    }
  }

  private disposeEditor(): void {
    this.editor?.dispose();
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    this.editor = null;
    this.originalModel = null;
    this.modifiedModel = null;
    this.mountedContainer = null;
    this.monacoReady.set(false);
  }

  private disposeMonaco(): void {
    this.disposeEditor();
  }
}
