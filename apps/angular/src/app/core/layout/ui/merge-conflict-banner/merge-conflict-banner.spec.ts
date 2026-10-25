import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConflictOperation, ConflictState } from '@core/services/repo-state.service';
import { MergeConflictBanner } from './merge-conflict-banner';

/**
 * Mirrors the shell wiring: the banner takes the conflict AND the operation
 * (derived from the same state), so both are seeded unless a test overrides it.
 */
function render(conflict: ConflictState | null, operation?: ConflictOperation) {
  const fixture = TestBed.createComponent(MergeConflictBanner);
  fixture.componentRef.setInput('conflict', conflict);
  fixture.componentRef.setInput('operation', operation ?? conflict?.operation ?? 'merge');
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ReturnType<typeof render>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

describe('MergeConflictBanner', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing without a conflict', () => {
    expect(query(render(null), 'merge-conflict-banner')).toBeNull();
    expect(
      query(render({ operation: 'merge', hasConflict: false, oid: '' }), 'merge-conflict-banner'),
    ).toBeNull();
  });

  it('explains how to resolve a conflicted merge', () => {
    const fixture = render({ operation: 'merge', hasConflict: true, oid: 'abc' });
    expect(query(fixture, 'merge-conflict-message')?.textContent).toContain('Resolve them');
    expect(query(fixture, 'merge-conflict-message')?.textContent).toContain(
      'The merge produced conflicts',
    );
  });

  it('names the cherry-pick operation', () => {
    const fixture = render({ operation: 'cherry-pick', hasConflict: true, oid: 'abc' });
    expect(query(fixture, 'merge-conflict-message')?.textContent).toContain(
      'The cherry-pick produced conflicts',
    );
  });

  it('names the revert operation', () => {
    const fixture = render({ operation: 'revert', hasConflict: true, oid: 'abc' });
    expect(query(fixture, 'merge-conflict-message')?.textContent).toContain(
      'The revert produced conflicts',
    );
  });

  it('defaults the operation to merge', () => {
    const fixture = TestBed.createComponent(MergeConflictBanner);
    fixture.componentRef.setInput('conflict', {
      operation: 'merge',
      hasConflict: true,
      oid: 'abc',
    } satisfies ConflictState);
    fixture.detectChanges();

    expect(fixture.componentInstance.operation()).toBe('merge');
    expect(query(fixture, 'merge-conflict-message')?.textContent).toContain(
      'The merge produced conflicts',
    );
  });

  it('emits dismiss when closed', () => {
    const fixture = render({ operation: 'merge', hasConflict: true, oid: 'abc' });
    let dismissed = 0;
    fixture.componentInstance.dismiss.subscribe(() => (dismissed += 1));

    query(fixture, 'merge-conflict-dismiss')?.click();

    expect(dismissed).toBe(1);
  });
});
