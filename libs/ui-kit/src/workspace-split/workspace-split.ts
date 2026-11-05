import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

/**
 * Mirrors `--st-size-pane-min` (320px): the floor for BOTH panes, so a drag can
 * never starve the detail pane — or, via the upper clamp below, the primary one
 * — below the minimum the token already declares.
 */
const MIN_DETAIL_WIDTH = 320;

/**
 * Mirrors `--st-size-detail-pane` (380px): the pixel width advertised as the
 * current `aria-valuenow` when the external `detailWidth` carries no px value.
 */
const DEFAULT_DETAIL_WIDTH = 380;

/**
 * The sanctioned no-explicit-width fallback: the 380px `--st-size-detail-pane`
 * token itself, so an app-side reset (`st:paneWidth` cleared) returns to the
 * layout default without the component hardcoding a pixel value.
 */
const DEFAULT_DETAIL_WIDTH_CSS = 'var(--st-size-detail-pane)';

/*
 * `$localize` is provided as a global by the renderer's `@angular/localize`
 * runtime (apps/angular), but the ui-kit package does not depend on
 * `@angular/localize` itself, so the library's own ng-packagr type-check has no
 * ambient declaration for it. Declaring it here (module scope, erased by the
 * compiler) keeps `npm run build --workspace=@singularitree/ui-kit` green while
 * the renderer's global wins at runtime — same call, same tagged template.
 */
declare const $localize: (strings: TemplateStringsArray, ...values: unknown[]) => string;

/** Parse a `123px` length; `%`, `calc()`, `var()` and anything else are not a known pixel width. */
function parsePxLength(value: string | null): number | null {
  if (!value) return null;
  if (!/^-?\d+(?:\.\d+)?px$/.test(value.trim())) return null;
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? Math.round(pixels) : null;
}

/**
 * Two-pane workspace primitive (plan §4.5/§4.6): a pinned detail pane plus a
 * flexible primary pane — never the sketch's two equal columns, which starve
 * the graph and the 12px-mono diff below ~1200px.
 *
 * Content projection: the default slot is the primary pane; elements marked
 * with the `detail` attribute are projected into the pinned detail pane, which
 * only renders while `showDetail()` is true. P2 mounts the split with the
 * primary slot only; P3 starts projecting the detail pane.
 *
 * An opt-in `resizable` divider (plan §4.9 pane width) sits at the detail
 * pane's right edge and emits a pixel width on every settled drag / keyboard
 * step. The component stays DUMB: it never reads the preference itself — the
 * app host binds `detailWidth` in and persists `detailWidthResized` back out.
 *
 * At ≤800px (plan §5 P6) the two panes collapse to a column: the pinned detail
 * becomes a full-width top band (capped height, horizontal hairline) and the
 * primary pane takes the rest. Structural only — no colour literal is added.
 */
@Component({
  selector: 'st-workspace-split',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // While a drag is in flight the whole split shows the resize cursor.
    '[attr.data-resizing]': 'resizing() ? "true" : null',
  },
  template: `
    @if (showDetail()) {
      <section
        class="st-workspace-split__detail"
        data-testid="workspace-detail"
        [style.width]="detailPaneWidth()"
      >
        @if (detailTitle()) {
          <header class="st-workspace-split__detail-header" data-testid="workspace-detail-header">
            {{ detailTitle() }}
          </header>
        }
        <div class="st-workspace-split__detail-body"><ng-content select="[detail]" /></div>
        @if (resizable()) {
          <div
            class="st-workspace-split__divider"
            data-testid="workspace-divider"
            role="separator"
            aria-orientation="vertical"
            tabindex="0"
            [attr.aria-label]="resizeLabel"
            [attr.aria-valuemin]="minWidth"
            [attr.aria-valuemax]="maxWidth()"
            [attr.aria-valuenow]="currentWidth()"
            [attr.data-resizing]="resizing() ? 'true' : null"
            (pointerdown)="onPointerDown($event)"
            (pointermove)="onPointerMove($event)"
            (pointerup)="onPointerUp($event)"
            (pointercancel)="onPointerCancel($event)"
            (keydown)="onKeyDown($event)"
          ></div>
        }
      </section>
    }
    <section class="st-workspace-split__primary" data-testid="workspace-primary">
      <ng-content />
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex: 1 1 auto;
      min-width: 0;
      height: 100%;
    }

    /* While dragging, the split owns the pointer: show the resize cursor and
       stop text selection from flickering across the two panes. */
    :host([data-resizing]) {
      cursor: col-resize;
      user-select: none;
    }

    .st-workspace-split__detail {
      display: flex;
      flex: none;
      flex-direction: column;
      min-width: 0;
      position: relative; /* anchors the absolutely-positioned divider at its right edge */
      background: var(--st-color-surface);
      border-right: var(--st-hairline) solid var(--st-color-border);
    }

    .st-workspace-split__detail-header {
      display: flex;
      align-items: center;
      flex: none;
      height: var(--st-size-row-tree-dense);
      padding: 0 var(--st-space-3);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      font-size: var(--st-font-13);
      font-weight: 600;
    }

    .st-workspace-split__detail-body {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
    }

    /* Opt-in resize divider (only rendered while resizable). Absolutely
       positioned so it never joins the pane's flex flow: the pane width is
       driven exclusively by the [style.width] binding, never by the handle. */
    .st-workspace-split__divider {
      position: absolute;
      top: 0;
      bottom: 0;
      /* Shifted one hairline right so the 5px hit area straddles the boundary
         instead of eating into (and doubling) the pane's own border-right. */
      right: calc(-1 * var(--st-hairline));
      width: 5px;
      flex: none;
      cursor: col-resize;
      touch-action: none; /* the strip owns the gesture; nothing scrolls/pans beneath it */
    }

    /* The 1px grip line — same feel as the hairline it overlays. */
    .st-workspace-split__divider::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      right: 0;
      width: var(--st-hairline);
      background: var(--st-color-border);
      transition: background-color var(--st-motion-fast) var(--st-ease);
    }

    .st-workspace-split__divider:hover::before,
    .st-workspace-split__divider:focus-visible::before,
    .st-workspace-split__divider:active::before {
      background: var(--st-color-accent);
    }

    .st-workspace-split__divider:focus-visible {
      /* The inset-row variant: a positive offset would bleed outside the 5px strip. */
      outline: 2px solid var(--st-color-focus);
      outline-offset: -1px;
    }

    .st-workspace-split__primary {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-width: 0;
    }

    /* ≤800 split collapse (plan §5 P6): the pinned detail becomes a full-width
       top band; the primary pane takes the rest. */
    @media (max-width: 800px) {
      :host {
        flex-direction: column;
      }

      .st-workspace-split__detail {
        width: 100% !important; /* inline [style.width] binding needs the sanctioned override */
        max-width: 100%;
        flex: 0 0 auto;
        max-height: 40%;
        border-right: 0;
        border-bottom: var(--st-hairline) solid var(--st-color-border);
      }

      /* The panes stack at ≤800px, so a vertical resize divider is meaningless. */
      .st-workspace-split__divider {
        display: none;
      }
    }
  `,
})
export class WorkspaceSplitComponent {
  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly showDetail = input(false);
  /** Explicit detail-pane width as a CSS length (e.g. `'420px'`); null = no explicit width. */
  readonly detailWidth = input<string | null>(null);
  readonly detailTitle = input('');
  /** Opt-in: renders the drag/keyboard divider between the two panes. */
  readonly resizable = input(false);
  /** Emitted (once per drag end / keyboard step) with the new width in pixels. */
  readonly detailWidthResized = output<number>();

  /** Accessible name for the divider (routed through the i18n catalogue). */
  readonly resizeLabel = $localize`Resize detail pane`;

  /** Exposed as a field so the template can bind `aria-valuemin`. */
  readonly minWidth = MIN_DETAIL_WIDTH;

  /** Local drag override; null = "the external `detailWidth` input governs". */
  private readonly dragWidth = signal<number | null>(null);
  private readonly resizingState = signal(false);

  /** True while a pointer drag is in flight — drives the cursor + `data-resizing`. */
  readonly resizing = this.resizingState.asReadonly();

  private dragStartX = 0;
  private dragStartWidth = 0;
  private activePointerId: number | null = null;

  /** The width actually applied: a live drag wins, otherwise the external input or the token default. */
  readonly detailPaneWidth = computed(() => {
    const drag = this.dragWidth();
    if (drag !== null) return `${drag}px`;
    return this.detailWidth() ?? DEFAULT_DETAIL_WIDTH_CSS;
  });

  /** The pixel value reported to assistive tech as the current `aria-valuenow`. */
  readonly currentWidth = computed(() => {
    const drag = this.dragWidth();
    if (drag !== null) return drag;
    return parsePxLength(this.detailWidth()) ?? DEFAULT_DETAIL_WIDTH;
  });

  constructor() {
    // An externally driven width change (restored from storage, or the Settings
    // "reset pane width" clearing the preference) must WIN over a finished drag.
    // This effect reads only `detailWidth()`, so it re-runs exactly when that
    // input changes — which IS the external-change signal — and drops the local
    // drag override. `untracked` keeps the `dragWidth` write out of the
    // dependency set, so live drag updates never re-trigger it.
    effect(() => {
      this.detailWidth();
      untracked(() => this.dragWidth.set(null));
    });
  }

  /** Upper clamp: keep the primary pane at least `--st-size-pane-min` (320px). */
  maxWidth(): number {
    return Math.max(MIN_DETAIL_WIDTH, this.hostElement.nativeElement.clientWidth - MIN_DETAIL_WIDTH);
  }

  onPointerDown(event: PointerEvent): void {
    if (!this.resizable()) return;
    event.preventDefault();
    const divider = event.currentTarget as HTMLElement;
    // jsdom implements no pointer capture; guard so the unit suite never throws.
    if (typeof divider.setPointerCapture === 'function') {
      divider.setPointerCapture(event.pointerId);
    }
    // `preventDefault` suppressed the browser's own focus-on-click, and the
    // handle must be focused for the arrow keys to reach it — restore it
    // explicitly (guarded for the specs' synthetic events).
    if (typeof divider.focus === 'function') divider.focus();
    this.activePointerId = event.pointerId;
    this.dragStartX = event.clientX;
    // Measure the live pane; jsdom reports a 0-width rect, so fall back to the
    // externally known width there instead of capturing a bogus start.
    const measured = Math.round(this.detailRect()?.width ?? 0);
    this.dragStartWidth = measured > 0 ? measured : this.currentWidth();
    this.resizingState.set(true);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.resizing() || event.pointerId !== this.activePointerId) return;
    // Live width: the pointer delta is added to the width captured at pointerdown.
    this.dragWidth.set(this.clampWidth(this.dragStartWidth + (event.clientX - this.dragStartX)));
  }

  onPointerUp(event: PointerEvent): void {
    if (!this.resizing() || event.pointerId !== this.activePointerId) return;
    this.finishResize(event.currentTarget as HTMLElement);
  }

  onPointerCancel(event: PointerEvent): void {
    if (!this.resizing() || event.pointerId !== this.activePointerId) return;
    this.finishResize(event.currentTarget as HTMLElement);
  }

  onKeyDown(event: KeyboardEvent): void {
    if (!this.resizable()) return;
    const step = event.shiftKey ? 64 : 16; // Shift = coarse steps
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = this.currentWidth() - step;
        break;
      case 'ArrowRight':
        next = this.currentWidth() + step;
        break;
      case 'Home':
        next = MIN_DETAIL_WIDTH;
        break;
      case 'End':
        next = this.maxWidth();
        break;
      default:
        return; // Not a resize key: leave the event for the browser/assistive tech.
    }
    event.preventDefault();
    const width = this.clampWidth(next);
    this.dragWidth.set(width);
    this.detailWidthResized.emit(width);
  }

  private finishResize(divider: HTMLElement): void {
    // The browser already drops capture implicitly at pointerup/pointercancel,
    // and an explicit release for a pointer that is no longer active throws in
    // some engines — a cancelled gesture must never raise from this handler.
    try {
      if (this.activePointerId !== null && typeof divider.releasePointerCapture === 'function') {
        divider.releasePointerCapture(this.activePointerId);
      }
    } catch {
      /* capture already gone */
    }
    this.activePointerId = null;
    this.resizingState.set(false);
    // A click without a move still reports the (unchanged) width, so the host
    // can persist a starting point.
    this.detailWidthResized.emit(this.dragWidth() ?? this.clampWidth(this.dragStartWidth));
  }

  private clampWidth(width: number): number {
    return Math.round(Math.min(Math.max(width, MIN_DETAIL_WIDTH), this.maxWidth()));
  }

  private detailRect(): DOMRect | null {
    // Host-scoped lookup: never touch `document` (the component may be nested).
    const detail = this.hostElement.nativeElement.querySelector<HTMLElement>(
      '.st-workspace-split__detail',
    );
    return detail?.getBoundingClientRect() ?? null;
  }
}
