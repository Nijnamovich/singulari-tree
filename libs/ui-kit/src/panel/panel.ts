import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Dumb panel + section header (plan §4.4/§4.5/§4.7/§4.9).
 *
 * Two content slots: the default slot is the body, and any element marked with
 * the `header` attribute is projected into the header strip (an eyebrow + title
 * + optional badge composed by the consumer). The header sticks to the top of
 * the panel's scroll container by default.
 */
@Component({
  selector: 'st-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="st-panel__header"
      data-testid="panel-header"
      [class.st-panel__header--sticky]="stickyHeader()"
    >
      <ng-content select="[header]" />
    </div>
    <div class="st-panel__body" data-testid="panel-body"><ng-content /></div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: var(--st-color-surface);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-3);
    }

    .st-panel__header {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      min-height: var(--st-size-control-md);
      padding: var(--st-space-2) var(--st-space-3);
    }

    .st-panel__header--sticky {
      position: sticky;
      top: 0;
      z-index: var(--st-z-sticky);
      background: var(--st-color-surface);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
    }

    .st-panel__body {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
    }
  `,
})
export class PanelComponent {
  readonly stickyHeader = input(true);
}
