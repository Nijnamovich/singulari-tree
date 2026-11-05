import { Injectable, signal } from '@angular/core';

/**
 * Root-scoped signal carrier for ambient announcements (plan §3 status bar).
 *
 * The service owns the message; the shell binds `<st-live-region [message]="…">`
 * to `message`. `announce()` is the single mutation point, so every producer
 * (fetch-all progress, sync results, notices) publishes through one region
 * instead of each minting its own `aria-live` node.
 */
@Injectable({ providedIn: 'root' })
export class LiveRegionService {
  private readonly current = signal('');

  readonly message = this.current.asReadonly();

  announce(text: string): void {
    this.current.set(text);
  }
}
