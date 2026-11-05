import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { RepoCardComponent, type RepoCardView } from '@singularitree/ui-kit';

// Exercises the ui-kit `<st-repo-card>` through the renderer test runner (the
// ui-kit package has no test runner of its own; it is AOT-compiled here).

const REPO: RepoCardView = {
  id: 'repo-1',
  name: 'singulari-tree',
  subtitle: '/tmp/singulari-tree',
  badge: 'main',
};

function render(overrides: Partial<RepoCardView> = {}, selected = false) {
  const fixture = TestBed.createComponent(RepoCardComponent);
  fixture.componentRef.setInput('repo', { ...REPO, ...overrides });
  fixture.componentRef.setInput('selected', selected);
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ReturnType<typeof render>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

describe('RepoCardComponent (ui-kit)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the name, subtitle and badge', () => {
    const fixture = render();

    expect(query(fixture, 'repo-card-name')?.textContent?.trim()).toBe('singulari-tree');
    expect(query(fixture, 'repo-card-subtitle')?.textContent?.trim()).toBe('/tmp/singulari-tree');
    expect(query(fixture, 'repo-card-badge')?.textContent?.trim()).toBe('main');
    // The badge is the shared ui-kit `<st-badge>`.
    expect(query(fixture, 'badge')?.className).toContain('st-badge--branch');
  });

  it('omits the optional subtitle and badge when absent', () => {
    const fixture = render({ subtitle: undefined, badge: undefined });

    expect(query(fixture, 'repo-card-name')?.textContent?.trim()).toBe('singulari-tree');
    expect(query(fixture, 'repo-card-subtitle')).toBeNull();
    expect(query(fixture, 'repo-card-badge')).toBeNull();
  });

  it('exposes the button role and reflects the selected state', () => {
    const fixture = render({}, true);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('data-testid')).toBe('repo-card');
    expect(el.className).toContain('st-repo-card--selected');
  });

  it('emits picked on click and on Enter', () => {
    const fixture = render();
    let picked = 0;
    fixture.componentInstance.picked.subscribe(() => (picked += 1));

    const el = fixture.nativeElement as HTMLElement;
    el.click();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(picked).toBe(2);
  });

  it('emits picked on Space and prevents the default scroll', () => {
    const fixture = render();
    let picked = 0;
    fixture.componentInstance.picked.subscribe(() => (picked += 1));

    const el = fixture.nativeElement as HTMLElement;
    const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    el.dispatchEvent(event);

    expect(picked).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
