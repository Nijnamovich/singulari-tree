import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LiveRegionComponent } from './live-region.component';
import { LiveRegionService } from './live-region.service';

async function render(message: string, politeness?: 'polite' | 'assertive'): Promise<HTMLElement> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(LiveRegionComponent);
  fixture.componentRef.setInput('message', message);
  if (politeness) fixture.componentRef.setInput('politeness', politeness);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('LiveRegionComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the message in a polite status region by default', async () => {
    const host = await render('Fetch complete');

    const region = host.querySelector('[data-testid="live-region"]')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.textContent).toContain('Fetch complete');
  });

  it('honours an assertive politeness', async () => {
    const host = await render('Sync failed', 'assertive');

    expect(host.querySelector('[data-testid="live-region"]')!.getAttribute('aria-live')).toBe(
      'assertive',
    );
  });
});

describe('LiveRegionService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('updates the message signal through announce()', () => {
    const service = TestBed.inject(LiveRegionService);

    expect(service.message()).toBe('');

    service.announce('Pulled 3 commits');

    expect(service.message()).toBe('Pulled 3 commits');
  });
});
