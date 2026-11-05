import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileStatusVariant } from '../file-status.models';
import { FileStatusVariantBar } from './file-status-variant-bar';

interface BarInputs {
  variant?: FileStatusVariant;
  branches?: string[];
  baseRef?: string;
  targetRef?: string;
  pendingCount?: number;
}

function render(inputs: BarInputs = {}): ComponentFixture<FileStatusVariantBar> {
  const fixture = TestBed.createComponent(FileStatusVariantBar);
  const ref = fixture.componentRef;
  ref.setInput('variant', inputs.variant ?? 'local');
  ref.setInput('branches', inputs.branches ?? []);
  ref.setInput('baseRef', inputs.baseRef ?? '');
  ref.setInput('targetRef', inputs.targetRef ?? '');
  ref.setInput('pendingCount', inputs.pendingCount ?? 0);
  fixture.detectChanges();
  return fixture;
}

function query<T extends HTMLElement = HTMLElement>(
  fixture: ComponentFixture<FileStatusVariantBar>,
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(
    `[data-testid="${testId}"]`,
  );
}

/** The `st-select` primitive renders exactly one inner `<select class="st-select">`. */
function targetSelect(fixture: ComponentFixture<FileStatusVariantBar>): HTMLSelectElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('.st-select');
}

describe('FileStatusVariantBar', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the three variant segments', () => {
    const fixture = render();

    const el = fixture.nativeElement as HTMLElement;
    expect(query(fixture, 'toggle-segment-local')?.textContent?.trim()).toBe('Local');
    expect(query(fixture, 'toggle-segment-commit')?.textContent?.trim()).toBe('Commit');
    expect(query(fixture, 'toggle-segment-pr')?.textContent?.trim()).toBe('Branch comparator');
    expect(el.querySelectorAll('[role="group"] [data-testid^="toggle-segment-"]')).toHaveLength(3);
  });

  it('badges the Local segment with the pending count', () => {
    const fixture = render({ pendingCount: 4 });

    const badge = query(fixture, 'toggle-segment-local')?.querySelector(
      '[data-testid="toggle-segment-count"]',
    );
    expect(badge?.textContent?.trim()).toBe('4');
  });

  it('hides the Local badge at zero and never badges the other segments', () => {
    const zero = render({ pendingCount: 0 });
    expect(
      query(zero, 'toggle-segment-local')?.querySelector('[data-testid="toggle-segment-count"]'),
    ).toBeNull();

    const counted = render({ pendingCount: 2 });
    expect(
      query(counted, 'toggle-segment-commit')?.querySelector('[data-testid="toggle-segment-count"]'),
    ).toBeNull();
    expect(
      query(counted, 'toggle-segment-pr')?.querySelector('[data-testid="toggle-segment-count"]'),
    ).toBeNull();
  });

  it('emits the variant picked by the user', () => {
    const fixture = render();
    const emitted: FileStatusVariant[] = [];
    fixture.componentInstance.variantChange.subscribe((variant) => emitted.push(variant));

    query(fixture, 'toggle-segment-local')?.click();
    query(fixture, 'toggle-segment-commit')?.click();
    query(fixture, 'toggle-segment-pr')?.click();

    expect(emitted).toEqual(['local', 'commit', 'pr']);
  });

  it('marks the active variant visually and for assistive tech', () => {
    const fixture = render({ variant: 'pr' });

    const pr = query(fixture, 'toggle-segment-pr');
    const local = query(fixture, 'toggle-segment-local');
    expect(pr?.classList.contains('st-toggle-group__segment--active')).toBe(true);
    expect(pr?.getAttribute('aria-pressed')).toBe('true');
    expect(local?.classList.contains('st-toggle-group__segment--active')).toBe(false);
    expect(local?.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders the PR ref controls only in the PR variant', () => {
    const local = render({ variant: 'local' });
    expect(query(local, 'pr-base-input')).toBeNull();
    expect(targetSelect(local)).toBeNull();

    const pr = render({ variant: 'pr' });
    expect(query(pr, 'pr-base-input')).not.toBeNull();
    expect(targetSelect(pr)).not.toBeNull();
  });

  it('populates the PR ref controls from the branch names', () => {
    const fixture = render({ variant: 'pr', branches: ['main', 'develop', 'origin/main'] });

    const select = targetSelect(fixture);
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((option) => option.value)).toEqual([
      'main',
      'develop',
      'origin/main',
    ]);

    // The base is an editable input: its datalist is fed by the same names.
    const input = query<HTMLInputElement>(fixture, 'pr-base-input');
    expect(input?.getAttribute('list')).toBe('st-file-status-variant__base-options');
    const datalist = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLOptionElement>(
      'datalist option',
    );
    expect(Array.from(datalist).map((option) => option.value)).toEqual([
      'main',
      'develop',
      'origin/main',
    ]);
  });

  it('reflects the current refs and emits their edits', () => {
    const fixture = render({
      variant: 'pr',
      branches: ['main', 'develop'],
      baseRef: 'main',
      targetRef: 'develop',
    });
    const bases: string[] = [];
    const targets: string[] = [];
    fixture.componentInstance.baseRefChange.subscribe((value) => bases.push(value));
    fixture.componentInstance.targetRefChange.subscribe((value) => targets.push(value));

    const base = query<HTMLInputElement>(fixture, 'pr-base-input');
    const target = targetSelect(fixture);
    expect(base?.value).toBe('main');
    expect(target?.value).toBe('develop');

    // The base is freely editable: any ref name can be typed.
    base!.value = 'release/1.0';
    base!.dispatchEvent(new Event('input'));
    target!.value = 'main';
    target!.dispatchEvent(new Event('change'));

    expect(bases).toEqual(['release/1.0']);
    expect(targets).toEqual(['main']);
  });
});
