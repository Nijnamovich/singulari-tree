import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { PopoverComponent } from '@singularitree/ui-kit';
import {
  checkoutTargetFor,
  type CheckoutTarget,
  type GraphContextMenuTarget,
  type ResetModeName,
} from '../graph-menu.models';
import { WIP_OID } from '../graph.store';

/**
 * Dumb, positioned right-click menu for a commit row (ADR-0022, ADR-028).
 *
 * It renders Checkout / Compare / Copy SHA, the create-branch-here and
 * tag-this-commit entries (lit up in M3 once the ref RPCs landed, ADR-028),
 * the File status entry and the Reset submenu (soft/mixed/hard). Compare and
 * File status are both navigation entries that emit for the page to select +
 * route (ADR-0030 item 4); neither renders a diff here. Cherry-pick and revert
 * remain out of scope and are never rendered: no dead actions ship.
 *
 * The component performs no RPC and touches no Git: it emits the chosen action
 * and the owning store/page decides what to do. It mounts on `st-popover`, which
 * owns Escape / outside-click / focus-out / backdrop dismissal; a second
 * context-menu gesture also dismisses it. It supports Arrow Up/Down focus
 * movement for keyboard use.
 */
@Component({
  selector: 'st-graph-context-menu',
  standalone: true,
  imports: [PopoverComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open() && target(); as ctx) {
      <!-- Internal full-viewport anchor: the viewport x/y coordinates resolve
           against it. It never becomes the pointer target itself -- the popover
           backdrop and the menu render above it. -->
      <div
        class="st-graph-context-menu__anchor"
        data-testid="ctx-backdrop"
        (click)="onBackdropClick($event)"
        (contextmenu)="onBackdropContextMenu($event)"
      >
        <st-popover [open]="open()" (closed)="closed.emit()">
          <div
            class="st-graph-context-menu"
            role="menu"
            aria-label="Commit actions"
            i18n-aria-label
            data-testid="graph-context-menu"
            [style.left.px]="x()"
            [style.top.px]="y()"
            (keydown)="onKeydown($event)"
          >
            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item"
              data-testid="ctx-checkout"
              [disabled]="busy()"
              (click)="onCheckout(ctx)"
            >
              <span>Checkout</span>
              <span class="st-graph-context-menu__hint" data-testid="ctx-checkout-target">{{
                checkoutTarget(ctx).label
              }}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item"
              data-testid="ctx-compare"
              [disabled]="!canCompare() || busy()"
              (click)="onCompare()"
            >
              Compare with selected
            </button>

            <!-- File status routes to the repo's file-status screen (ADR-0029). The
                 WIP row is a synthetic node with no commit to diff, so the entry is
                 disabled there. -->
            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item"
              data-testid="ctx-file-status"
              [disabled]="!canFileStatus() || busy()"
              (click)="onFileStatus(ctx)"
              i18n
            >
              File status
            </button>

            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item"
              data-testid="ctx-copy-sha"
              [disabled]="busy()"
              (click)="copySha.emit(ctx.oid)"
            >
              Copy SHA
            </button>

            <div class="st-graph-context-menu__separator" role="separator"></div>

            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item"
              data-testid="ctx-create-branch"
              [disabled]="busy()"
              (click)="onCreateBranchHere(ctx)"
            >
              Create branch here…
            </button>
            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item"
              data-testid="ctx-tag"
              [disabled]="busy()"
              (click)="onTagCommit(ctx)"
            >
              Tag this commit…
            </button>

            <div class="st-graph-context-menu__separator" role="separator"></div>
            <div class="st-graph-context-menu__group" aria-hidden="true">Reset</div>

            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item"
              data-testid="ctx-reset-soft"
              [disabled]="busy()"
              (click)="reset.emit(SOFT)"
            >
              Soft — keep changes staged
            </button>
            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item"
              data-testid="ctx-reset-mixed"
              [disabled]="busy()"
              (click)="reset.emit(MIXED)"
            >
              Mixed — unstage, keep files
            </button>
            <button
              type="button"
              role="menuitem"
              class="st-graph-context-menu__item st-graph-context-menu__item--danger"
              data-testid="ctx-reset-hard"
              [disabled]="busy()"
              (click)="reset.emit(HARD)"
            >
              Hard — discard changes…
            </button>
          </div>
        </st-popover>
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    /*
     * The anchor fills the viewport so the menu's absolute left/top (which are
     * viewport coordinates) resolve correctly. It sits below the popover's
     * backdrop and the menu, so it never swallows their pointer events.
     */
    .st-graph-context-menu__anchor {
      position: fixed;
      inset: 0;
      z-index: var(--st-z-backdrop);
    }

    /*
     * st-popover provides dismissal + z-scale; its panel is only a positioning
     * shell here. Neutralise the box so the menu paints itself. The anchor class
     * keeps this override above the primitive's own panel rule.
     */
    :host ::ng-deep .st-graph-context-menu__anchor .st-popover {
      position: absolute;
      top: 0;
      left: 0;
      width: 0;
      min-width: 0;
      padding: 0;
      background: transparent;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      animation: none;
    }

    .st-graph-context-menu {
      position: absolute;
      z-index: var(--st-z-menu);
      min-width: 208px;
      padding: 4px;
      background: var(--st-color-raised);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-4);
      color: var(--st-color-text);
      font-size: var(--st-font-12);
    }

    .st-graph-context-menu__item {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      width: 100%;
      padding: var(--st-space-1) var(--st-space-3);
      background: transparent;
      border: 0;
      border-radius: var(--st-radius-3);
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .st-graph-context-menu__item:hover:not(:disabled),
    .st-graph-context-menu__item:focus-visible {
      background: var(--st-color-accent-soft);
      outline: none;
    }

    .st-graph-context-menu__item:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .st-graph-context-menu__item--danger {
      color: var(--st-color-danger);
    }

    .st-graph-context-menu__hint {
      margin-left: auto;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--st-color-muted);
      font-family: var(--st-font-mono);
      font-size: var(--st-font-11);
    }

    .st-graph-context-menu__separator {
      height: var(--st-hairline);
      margin: var(--st-space-1) var(--st-space-2);
      background: var(--st-color-border);
    }

    .st-graph-context-menu__group {
      padding: var(--st-space-1) var(--st-space-3) 0;
      color: var(--st-color-muted);
      font-size: var(--st-font-10);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
  `,
})
export class GraphContextMenu {
  readonly open = input(false);
  readonly x = input(0);
  readonly y = input(0);
  readonly target = input<GraphContextMenuTarget | null>(null);
  /**
   * True when the menu target can be opened in the File status screen. The
   * owning page supplies the gate (ADR-0030 item 4).
   */
  readonly canCompare = input(false);
  /** True while an owning store operation is in flight (disables every entry). */
  readonly busy = input(false);

  readonly checkout = output<CheckoutTarget>();
  /** Emitted when the user picks "Compare with selected"; the page selects the commit and routes (ADR-0030). */
  readonly compare = output<void>();
  /** Open the File status screen for the menu commit; emits the full oid (ADR-0029). */
  readonly fileStatus = output<string>();
  readonly copySha = output<string>();
  /** Create a branch at the menu commit; emits the full oid (ADR-028). */
  readonly createBranchHere = output<string>();
  /** Create a tag at the menu commit; emits the full oid (ADR-028). */
  readonly tagCommit = output<string>();
  readonly reset = output<ResetModeName>();
  readonly closed = output<void>();

  /** Named modes exposed to the template so it never hardcodes strings. */
  readonly SOFT: ResetModeName = 'SOFT';
  readonly MIXED: ResetModeName = 'MIXED';
  readonly HARD: ResetModeName = 'HARD';

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Move focus into the menu when it opens so keyboard users land on an item.
    effect(() => {
      if (this.open() && this.target()) {
        queueMicrotask(() => this.enabledItems()[0]?.focus());
      }
    });
  }

  checkoutTarget(target: GraphContextMenuTarget): CheckoutTarget {
    return checkoutTargetFor(target);
  }

  onCheckout(target: GraphContextMenuTarget): void {
    if (this.busy()) return;
    this.checkout.emit(checkoutTargetFor(target));
  }

  onCompare(): void {
    if (!this.canCompare() || this.busy()) return;
    this.compare.emit();
  }

  /**
   * True when the menu target is a real commit that can be diffed. The synthetic
   * WIP row carries the `WIP_OID` pseudo-oid and no commit, so the entry is
   * disabled for it (ADR-0029).
   */
  readonly canFileStatus = computed(() => {
    const oid = this.target()?.oid ?? '';
    return !!oid && oid !== WIP_OID;
  });

  onFileStatus(target: GraphContextMenuTarget): void {
    if (!this.canFileStatus() || this.busy()) return;
    this.fileStatus.emit(target.oid);
  }

  onCreateBranchHere(target: GraphContextMenuTarget): void {
    if (this.busy()) return;
    this.createBranchHere.emit(target.oid);
  }

  onTagCommit(target: GraphContextMenuTarget): void {
    if (this.busy()) return;
    this.tagCommit.emit(target.oid);
  }

  /**
   * A direct hit on the anchor shell (outside the popover subtree) dismisses the
   * menu. A real outside click lands on the popover's own backdrop, which emits
   * `closed` before bubbling here, so guard against the double emit.
   */
  onBackdropClick(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    this.closed.emit();
  }

  /**
   * A right-click outside the menu dismisses it instead of showing the OS menu;
   * a right-click on an item is left untouched.
   */
  onBackdropContextMenu(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('.st-graph-context-menu')) return;
    event.preventDefault();
    this.closed.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Stop the document-level Escape listener from emitting a second close.
      event.stopPropagation();
      this.closed.emit();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();

    const items = this.enabledItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = current === -1 ? 0 : (current + delta + items.length) % items.length;
    items[next]?.focus();
  }

  private enabledItems(): HTMLElement[] {
    return Array.from(
      this.host.nativeElement.querySelectorAll<HTMLElement>(
        '.st-graph-context-menu__item:not(:disabled)',
      ),
    );
  }
}
