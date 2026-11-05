import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LiveRegionService } from '@singularitree/ui-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { StatusBar } from './status-bar';

interface Options {
  repo?: string;
  branch?: string;
  shortHash?: string;
  ahead?: number;
  behind?: number;
  offline?: boolean;
}

async function setup(opts: Options = {}): Promise<ComponentFixture<StatusBar>> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(StatusBar);
  fixture.componentRef.setInput('repo', opts.repo ?? '');
  fixture.componentRef.setInput('branch', opts.branch ?? '');
  fixture.componentRef.setInput('shortHash', opts.shortHash ?? '');
  fixture.componentRef.setInput('ahead', opts.ahead ?? 0);
  fixture.componentRef.setInput('behind', opts.behind ?? 0);
  fixture.componentRef.setInput('offline', opts.offline ?? false);
  fixture.detectChanges();
  return fixture;
}

function query<T extends Element>(
  fixture: ComponentFixture<StatusBar>,
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

describe('StatusBar', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('joins the provided context segments with a middot', async () => {
    const fixture = await setup({ repo: 'alpha', branch: 'main', shortHash: 'abc1234' });

    expect(query(fixture, 'status-bar-context')?.textContent?.trim()).toBe('alpha · main · abc1234');
  });

  it('omits missing context segments', async () => {
    const fixture = await setup({ repo: 'alpha' });

    expect(query(fixture, 'status-bar-context')?.textContent?.trim()).toBe('alpha');

    const empty = await setup();
    expect(query(empty, 'status-bar-context')).toBeNull();
  });

  it('shows the behind count when behind and an in-sync state otherwise', async () => {
    const behind = await setup({ behind: 3 });
    expect(query(behind, 'status-bar-behind')?.textContent?.trim()).toBe('↓3');
    expect(query(behind, 'status-bar-in-sync')).toBeNull();

    const synced = await setup({ behind: 0, ahead: 0 });
    expect(query(synced, 'status-bar-in-sync')).not.toBeNull();
  });

  it('shows the ahead count', async () => {
    const fixture = await setup({ ahead: 2 });

    expect(query(fixture, 'status-bar-ahead')?.textContent?.trim()).toBe('↑2');
  });

  it('reflects the online/offline dot state', async () => {
    const online = await setup({ offline: false });
    const onlineDot = query(online, 'status-bar-online-dot')!;
    expect(onlineDot.classList.contains('st-statusbar__dot--offline')).toBe(false);
    expect(onlineDot.getAttribute('aria-label')).toBe('Git core online');

    const offline = await setup({ offline: true });
    const offlineDot = query(offline, 'status-bar-online-dot')!;
    expect(offlineDot.classList.contains('st-statusbar__dot--offline')).toBe(true);
    expect(offlineDot.getAttribute('aria-label')).toBe('Git core offline');
  });

  it('renders an announced message in the live region', async () => {
    const fixture = await setup();
    const liveRegion = TestBed.inject(LiveRegionService);

    liveRegion.announce('Fetching repositories 1/3');
    fixture.detectChanges();

    const region = query(fixture, 'live-region')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Fetching repositories 1/3');
  });
});
