import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { TopBar, type TopBarTab } from './top-bar';

const TABS: TopBarTab[] = [
  { id: 'repo-1', label: 'alpha', branch: 'main' },
  { id: 'repo-2', label: 'beta' },
];

async function setup(
  inputs: Partial<{
    tabs: readonly TopBarTab[];
    activeTab: string | null;
    hasActiveRepo: boolean;
    canSync: boolean;
    pullPending: number;
    drawerPinned: boolean;
  }> = {},
): Promise<ComponentFixture<TopBar>> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  }).compileComponents();
  const fixture = TestBed.createComponent(TopBar);
  fixture.componentRef.setInput('tabs', inputs.tabs ?? TABS);
  fixture.componentRef.setInput('activeTab', inputs.activeTab ?? 'repo-1');
  fixture.componentRef.setInput('hasActiveRepo', inputs.hasActiveRepo ?? true);
  fixture.componentRef.setInput('canSync', inputs.canSync ?? false);
  fixture.componentRef.setInput('pullPending', inputs.pullPending ?? 0);
  fixture.componentRef.setInput('drawerPinned', inputs.drawerPinned ?? true);
  fixture.detectChanges();
  return fixture;
}

function host(fixture: ComponentFixture<TopBar>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

/** The native button inside a `<st-button>` host carrying `testId`. */
function button(fixture: ComponentFixture<TopBar>, testId: string): HTMLButtonElement | null {
  return host(fixture, testId)?.querySelector<HTMLButtonElement>('button') ?? null;
}

function tabs(fixture: ComponentFixture<TopBar>): HTMLElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.st-tab'));
}

describe('TopBar', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders one tab per input, the active one marked and branchy', async () => {
    const fixture = await setup();

    const els = tabs(fixture);
    expect(els).toHaveLength(2);
    expect(els[0].textContent).toContain('alpha');
    expect(els[1].textContent).toContain('beta');
    expect(els[0].classList.contains('st-tab--active')).toBe(true);
    expect(els[0].getAttribute('aria-selected')).toBe('true');
    expect(els[0].textContent).toContain('main');
    expect(els[1].getAttribute('aria-selected')).toBe('false');
  });

  it('emits the tab id on click', async () => {
    const fixture = await setup();
    const emitted: string[] = [];
    fixture.componentInstance.tabSelected.subscribe((id) => emitted.push(id));

    tabs(fixture)[1].click();

    expect(emitted).toEqual(['repo-2']);
  });

  it('emits the tab id on Enter and Space', async () => {
    const fixture = await setup();
    const emitted: string[] = [];
    fixture.componentInstance.tabSelected.subscribe((id) => emitted.push(id));

    tabs(fixture)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    tabs(fixture)[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));

    expect(emitted).toEqual(['repo-1', 'repo-1']);
  });

  it('emits tabClosed without also selecting when the close control is used', async () => {
    const fixture = await setup();
    const selected: string[] = [];
    const closed: string[] = [];
    fixture.componentInstance.tabSelected.subscribe((id) => selected.push(id));
    fixture.componentInstance.tabClosed.subscribe((id) => closed.push(id));

    tabs(fixture)[0].querySelector<HTMLButtonElement>('.st-tab__close')!.click();

    expect(closed).toEqual(['repo-1']);
    expect(selected).toEqual([]);
  });

  it('emits addRequested from the "+" control', async () => {
    const fixture = await setup();
    let added = 0;
    fixture.componentInstance.addRequested.subscribe(() => added++);

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.st-tab__add')!
      .click();

    expect(added).toBe(1);
  });

  it('gates the remote-op cluster on hasActiveRepo', async () => {
    const inactive = await setup({ hasActiveRepo: false });
    for (const id of ['top-bar-pull', 'top-bar-push', 'top-bar-fetch', 'top-bar-copy-repo-url']) {
      expect(button(inactive, id)!.disabled).toBe(true);
    }
    // Clone-from-clipboard is independent of an active repo.
    expect(button(inactive, 'top-bar-clone-clipboard')!.disabled).toBe(false);

    const active = await setup({ hasActiveRepo: true });
    for (const id of ['top-bar-pull', 'top-bar-push', 'top-bar-fetch', 'top-bar-copy-repo-url']) {
      expect(button(active, id)!.disabled).toBe(false);
    }
  });

  it('gates Sync on canSync', async () => {
    const disabled = await setup({ canSync: false });
    expect(button(disabled, 'top-bar-sync')!.disabled).toBe(true);

    const enabled = await setup({ canSync: true });
    expect(button(enabled, 'top-bar-sync')!.disabled).toBe(false);
  });

  it('emits the remote-op intents', async () => {
    const fixture = await setup({ canSync: true });
    const events: string[] = [];
    fixture.componentInstance.pullRequested.subscribe(() => events.push('pull'));
    fixture.componentInstance.pushRequested.subscribe(() => events.push('push'));
    fixture.componentInstance.fetchRequested.subscribe(() => events.push('fetch'));
    fixture.componentInstance.syncRequested.subscribe(() => events.push('sync'));
    fixture.componentInstance.cloneFromClipboardRequested.subscribe(() => events.push('clone'));
    fixture.componentInstance.copyRepoUrlRequested.subscribe(() => events.push('copy-url'));

    button(fixture, 'top-bar-pull')!.click();
    button(fixture, 'top-bar-push')!.click();
    button(fixture, 'top-bar-fetch')!.click();
    button(fixture, 'top-bar-sync')!.click();
    button(fixture, 'top-bar-clone-clipboard')!.click();
    button(fixture, 'top-bar-copy-repo-url')!.click();

    expect(events).toEqual(['pull', 'push', 'fetch', 'sync', 'clone', 'copy-url']);
  });

  it('renders the pull badge only when there is something pending', async () => {
    const clean = await setup({ pullPending: 0 });
    expect(host(clean, 'top-bar-pull-badge')).toBeNull();
    expect(host(clean, 'top-bar-sync-pill')?.textContent).toContain('Synced');

    const pending = await setup({ pullPending: 4 });
    expect(host(pending, 'top-bar-pull-badge')?.textContent?.trim()).toBe('4');
    expect(host(pending, 'top-bar-sync-pill')?.textContent).toContain('↓4');
  });

  it('highlights Push as the one primary action and demotes its neighbours', async () => {
    const fixture = await setup();

    // Push carries the turquoise primary fill; Pull and Fetch stay secondary.
    expect(button(fixture, 'top-bar-push')!.classList.contains('st-button--primary')).toBe(true);
    expect(button(fixture, 'top-bar-pull')!.classList.contains('st-button--primary')).toBe(false);
    expect(button(fixture, 'top-bar-fetch')!.classList.contains('st-button--primary')).toBe(false);
  });

  it('gives Sync the neutral info variant with a blue interaction accent', async () => {
    const fixture = await setup({ canSync: true });
    expect(button(fixture, 'top-bar-sync')!.classList.contains('st-button--info')).toBe(true);
    expect(button(fixture, 'top-bar-sync')!.classList.contains('st-button--primary')).toBe(false);
  });

  it('shows a success sync pill when clean and a warning one while a pull is pending', async () => {
    const clean = await setup({ pullPending: 0 });
    const cleanPill = host(clean, 'top-bar-sync-pill');
    expect(cleanPill?.querySelector('.st-badge--success')).not.toBeNull();
    expect(cleanPill?.querySelector('.st-badge--warning')).toBeNull();

    const pending = await setup({ pullPending: 3 });
    const pendingPill = host(pending, 'top-bar-sync-pill');
    expect(pendingPill?.querySelector('.st-badge--warning')).not.toBeNull();
    expect(pendingPill?.querySelector('.st-badge--success')).toBeNull();
  });

  it('renders no overflow toggle and no popover', async () => {
    const fixture = await setup();
    const el = fixture.nativeElement as HTMLElement;

    expect(host(fixture, 'top-bar-overflow-toggle')).toBeNull();
    expect(host(fixture, 'popover')).toBeNull();
    expect(el.querySelector('st-popover')).toBeNull();
  });

  it('routes to the GitHub account from a labelled direct icon link', async () => {
    const fixture = await setup();
    const link = host(fixture, 'top-bar-nav-github');

    expect(link).not.toBeNull();
    expect(link!.tagName).toBe('A');
    expect(link!.getAttribute('href')).toBe('/github-account');
    expect(link!.textContent).toContain('GitHub account');
    // A native anchor is keyboard-operable on its own; it carries no popup contract.
    expect(link!.hasAttribute('aria-haspopup')).toBe(false);
    expect(link!.hasAttribute('aria-expanded')).toBe(false);
  });

  it('routes to Settings from a labelled direct icon link', async () => {
    const fixture = await setup();
    const link = host(fixture, 'top-bar-nav-settings');

    expect(link).not.toBeNull();
    expect(link!.tagName).toBe('A');
    expect(link!.getAttribute('href')).toBe('/settings');
    expect(link!.textContent).toContain('Settings');
  });

  it('reflects the pinned drawer state and emits the toggle intent', async () => {
    const pinned = await setup({ drawerPinned: true });
    expect(host(pinned, 'top-bar-drawer-toggle')?.getAttribute('aria-expanded')).toBe('true');
    let toggles = 0;
    pinned.componentInstance.drawerToggled.subscribe(() => toggles++);
    button(pinned, 'top-bar-drawer-toggle')!.click();
    expect(toggles).toBe(1);

    const unpinned = await setup({ drawerPinned: false });
    expect(host(unpinned, 'top-bar-drawer-toggle')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('marks only the active tab with the full selection treatment', async () => {
    const fixture = await setup();
    const els = tabs(fixture);

    expect(els[0].classList.contains('st-tab--active')).toBe(true);
    expect(els[0].classList.contains('st-selection-bar')).toBe(true);
    expect(els[1].classList.contains('st-tab--active')).toBe(false);
    expect(els[1].classList.contains('st-selection-bar')).toBe(false);
  });

  it('gives the active and inactive tabs observably different fill and text colours', async () => {
    const fixture = await setup();
    const els = tabs(fixture);
    const active = getComputedStyle(els[0]);
    const inactive = getComputedStyle(els[1]);

    // The active tab carries the selected fill; the inactive tab stays unfilled.
    expect(active.backgroundColor).not.toBe(inactive.backgroundColor);
    expect(active.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    // Full-strength text on the active tab vs the muted colour on the inactive one.
    expect(active.color).not.toBe(inactive.color);
  });

  it('exposes the focus-ring vocabulary and a labelled close on every tab', async () => {
    const fixture = await setup();

    for (const tab of tabs(fixture)) {
      // Row-like tab: role/tabindex plus the shared inset focus-ring class.
      expect(tab.getAttribute('role')).toBe('tab');
      expect(tab.getAttribute('tabindex')).toBe('0');
      expect(tab.classList.contains('st-focus-ring--inset')).toBe(true);

      const close = tab.querySelector<HTMLButtonElement>('.st-tab__close');
      expect(close).not.toBeNull();
      expect(close!.type).toBe('button');
      expect(close!.getAttribute('aria-label')).toBe('Close tab');
      expect(close!.classList.contains('st-focus-ring--inset')).toBe(true);
    }

    // The standalone "+" control gets the standard ring.
    const add = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.st-tab__add',
    );
    expect(add!.getAttribute('aria-label')).toBe('Add tab');
    expect(add!.classList.contains('st-focus-ring')).toBe(true);
  });

  it('keeps the close control labelled and operable on both the active and inactive tab', async () => {
    const fixture = await setup();
    const selected: string[] = [];
    const closed: string[] = [];
    fixture.componentInstance.tabSelected.subscribe((id) => selected.push(id));
    fixture.componentInstance.tabClosed.subscribe((id) => closed.push(id));

    const els = tabs(fixture);
    expect(els[0].querySelector('.st-tab__close')?.getAttribute('aria-label')).toBe('Close tab');
    expect(els[1].querySelector('.st-tab__close')?.getAttribute('aria-label')).toBe('Close tab');

    els[1].querySelector<HTMLButtonElement>('.st-tab__close')!.click();

    expect(closed).toEqual(['repo-2']);
    expect(selected).toEqual([]);
  });
});
