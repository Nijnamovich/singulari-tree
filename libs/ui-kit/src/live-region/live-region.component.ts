import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type LiveRegionPoliteness = 'polite' | 'assertive';

/**
 * Dumb announcer host (plan §3/§4.8): a visually hidden `role="status"` region
 * that carries the status bar's ambient messages to assistive technology. Bind
 * `message` to whatever the parent (or `LiveRegionService`) wants announced.
 */
@Component({
  selector: 'st-live-region',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="st-live-region"
      data-testid="live-region"
      role="status"
      aria-atomic="true"
      [attr.aria-live]="politeness()"
    >
      {{ message() }}
    </div>
  `,
  styles: `
    /*
     * Visually hidden: no semantic token exists for the off-screen clip plain,
     * so the primitive carries its own 1px values (as authorised for this one
     * component).
     */
    .st-live-region {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
  `,
})
export class LiveRegionComponent {
  readonly message = input('');
  readonly politeness = input<LiveRegionPoliteness>('polite');
}
