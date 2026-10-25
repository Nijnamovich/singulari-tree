import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { AppError } from '@core/services/ipc-bridge.service';

/**
 * Read `details.paths` defensively. The Go core reports the conflicting files
 * as a single newline-joined string under `CHECKOUT_FAILED`; anything else
 * (missing `details`, a non-string value, or an empty string) yields `null`
 * so the banner simply omits the list.
 */
function readConflictPaths(error: AppError | null): string[] | null {
  const paths = error?.details?.['paths'];
  if (typeof paths !== 'string' || paths.length === 0) return null;
  return paths.split('\n');
}

/**
 * Dumb, presentational banner for a failed branch checkout.
 *
 * The parent (shell) owns the error state and the dismiss side effect; this
 * component only renders the friendly headline supplied by the core plus the
 * conflicting file list, and emits `dismiss` when the user closes it. It never
 * surfaces raw IPC diagnostics (`ST_APP_ERROR:{…}` / `exit status`) — those live
 * in `details.raw` and stay out of the primary UI.
 */
@Component({
  selector: 'st-checkout-error-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as err) {
      <div class="st-checkout-error" role="alert" data-testid="checkout-error-banner">
        <div class="st-checkout-error__body">
          <p class="st-checkout-error__message" data-testid="checkout-error-message">
            {{ err.message }}
          </p>
          @if (paths(); as conflictPaths) {
            <ul class="st-checkout-error__paths" data-testid="checkout-error-paths">
              @for (path of conflictPaths; track $index) {
                <li class="st-checkout-error__path" data-testid="checkout-error-path">
                  {{ path }}
                </li>
              }
            </ul>
          }
        </div>
        <button
          class="st-checkout-error__dismiss"
          type="button"
          data-testid="checkout-error-dismiss"
          title="Dismiss"
          i18n-title
          (click)="dismiss.emit()"
        >
          ✕
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .st-checkout-error {
      display: flex;
      align-items: flex-start;
      gap: var(--st-space-2);
      padding: var(--st-space-2) var(--st-space-3);
      background: var(--st-color-danger-soft);
      border-bottom: 1px solid var(--st-color-danger);
      color: var(--st-color-danger);
      font-size: 12.5px;
    }

    .st-checkout-error__body {
      flex: 1;
      min-width: 0;
    }

    .st-checkout-error__message {
      margin: 0;
      font-weight: 600;
    }

    .st-checkout-error__paths {
      margin: var(--st-space-1) 0 0;
      padding-left: 18px;
      max-height: 120px;
      overflow: auto;
      font-family: var(--st-font-mono);
      font-size: 11.5px;
    }

    .st-checkout-error__path {
      word-break: break-word;
    }

    .st-checkout-error__dismiss {
      flex: none;
      background: transparent;
      border: 1px solid var(--st-color-danger);
      color: var(--st-color-danger);
      border-radius: 4px;
      cursor: pointer;
      padding: var(--st-hairline) var(--st-space-2);
      line-height: 1.4;
    }

    .st-checkout-error__dismiss:hover {
      background: var(--st-color-danger-soft);
    }
  `,
})
export class CheckoutErrorBanner {
  readonly error = input<AppError | null>(null);
  readonly dismiss = output<void>();

  /** Conflict paths split out of `details.paths`, or `null` when absent. */
  readonly paths = computed(() => readConflictPaths(this.error()));
}
