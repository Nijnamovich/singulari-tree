import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Commit, CommitStats, Lane } from '@contracts/domain';
import { GRAPH_ROW_HEIGHT, GraphRow, laneColor } from '@singularitree/ui-kit';

// Exercises the ui-kit `<st-graph-row>` through the renderer test runner (the
// ui-kit package has no test runner of its own; it is AOT-compiled here).

function makeCommit(overrides: Partial<Commit> = {}): Commit {
  return {
    oid: { hex: 'abcdef1234567890', kind: 'SHA1' },
    parents: [],
    author: { name: 'Ada Lovelace', email: 'ada@example.com', when: '2026-01-02T10:00:00Z' },
    committer: undefined,
    message: 'feat(graph): render lane segment\n\nlong body that must not leak into the row',
    treeOid: undefined,
    committedAt: '2026-01-02T10:05:00Z',
    refs: [],
    ...overrides,
  };
}

function makeLane(overrides: Partial<Lane> = {}): Lane {
  return { index: 0, color: 0, continues: false, ...overrides };
}

function render(commit: Commit, lane: Lane, selected = false, stats: CommitStats | null = null) {
  const fixture = TestBed.createComponent(GraphRow);
  fixture.componentRef.setInput('commit', commit);
  fixture.componentRef.setInput('lane', lane);
  fixture.componentRef.setInput('selected', selected);
  fixture.componentRef.setInput('maxLane', 2);
  fixture.componentRef.setInput('stats', stats);
  fixture.detectChanges();
  return fixture;
}

describe('GraphRow (ui-kit)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the short oid, message subject, author and date', () => {
    const fixture = render(makeCommit(), makeLane());
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="graph-row-oid"]')?.textContent?.trim()).toBe('abcdef1');
    expect(el.querySelector('[data-testid="graph-row-message"]')?.textContent?.trim()).toBe(
      'feat(graph): render lane segment',
    );
    expect(el.querySelector('[data-testid="graph-row-author"]')?.textContent?.trim()).toBe(
      'Ada Lovelace',
    );
    expect(el.querySelector('[data-testid="graph-row-date"]')?.textContent?.trim()).toBe('2026-01-02');
  });

  it('renders one ref label per commit ref, styled by kind', () => {
    const commit = makeCommit({
      refs: [
        { name: 'main', kind: 'head' },
        { name: 'origin/main', kind: 'remote' },
        { name: 'v1.0.0', kind: 'tag' },
      ],
    });
    const fixture = render(commit, makeLane());
    const el = fixture.nativeElement as HTMLElement;

    const refs = Array.from(el.querySelectorAll('[data-testid="graph-row-ref"]'));
    expect(refs.map((ref) => ref.textContent?.trim())).toEqual(['main', 'origin/main', 'v1.0.0']);
    expect(refs[0]?.className).toContain('st-graph-row__ref--head');
    expect(refs[1]?.className).toContain('st-graph-row__ref--remote');
    expect(refs[2]?.className).toContain('st-graph-row__ref--tag');
  });

  it('styles the mainline branch ref with the mint --main role', () => {
    const commit = makeCommit({
      refs: [
        { name: 'main', kind: 'branch' },
        { name: 'master', kind: 'branch' },
      ],
    });
    const fixture = render(commit, makeLane());
    const refs = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="graph-row-ref"]'),
    );

    expect(refs).toHaveLength(2);
    expect(refs[0]?.className).toContain('st-graph-row__ref--main');
    expect(refs[1]?.className).toContain('st-graph-row__ref--main');
  });

  it('styles a non-mainline branch ref with the branch role', () => {
    const commit = makeCommit({ refs: [{ name: 'feature/tokens', kind: 'branch' }] });
    const fixture = render(commit, makeLane());
    const ref = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="graph-row-ref"]',
    );

    expect(ref?.className).toContain('st-graph-row__ref--branch');
    expect(ref?.className).not.toContain('st-graph-row__ref--main');
  });

  it('marks a selected row with the selected fill and the selection bar', () => {
    const fixture = render(makeCommit(), makeLane(), true);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.className).toContain('st-graph-row--selected');
    expect(el.className).toContain('st-selection-bar');
  });

  it('draws the lane vertical line only when the lane continues, using the palette color', () => {
    const continues = render(makeCommit(), makeLane({ color: 1, continues: true }));
    const line = (continues.nativeElement as HTMLElement).querySelector('line');
    expect(line).not.toBeNull();
    expect(line?.getAttribute('stroke')).toBe(laneColor(1));

    const ends = render(makeCommit(), makeLane({ continues: false }));
    expect((ends.nativeElement as HTMLElement).querySelector('line')).toBeNull();
    expect((ends.nativeElement as HTMLElement).querySelector('circle')).not.toBeNull();
  });

  it('positions the lane node by lane index and keeps the fixed 28px row height', () => {
    const fixture = render(makeCommit(), makeLane({ index: 2 }));
    const el = fixture.nativeElement as HTMLElement;
    const svg = el.querySelector('svg');

    expect(GRAPH_ROW_HEIGHT).toBe(28);
    expect(el.style.height).toBe('28px');
    // (maxLane 2 + 1) columns * 14px = 42px
    expect(svg?.getAttribute('width')).toBe('42');
    // node x = index 2 * 14 + 7 = 35
    expect(svg?.querySelector('circle')?.getAttribute('cx')).toBe('35');
  });

  it('reflects the selected state and emits picked on click', () => {
    const fixture = render(makeCommit(), makeLane(), true);
    let picked = 0;
    fixture.componentInstance.picked.subscribe(() => (picked += 1));

    const el = fixture.nativeElement as HTMLElement;
    expect(el.className).toContain('st-graph-row--selected');
    el.click();
    expect(picked).toBe(1);
  });

  it('tolerates a commit without refs', () => {
    const commit = makeCommit();
    // Simulate a payload from an older core that omits `refs` at runtime.
    (commit as unknown as { refs: undefined }).refs = undefined;
    const fixture = render(commit, makeLane());
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="graph-row-ref"]'),
    ).toHaveLength(0);
  });

  it('renders the change-size gauge when stats are available', () => {
    const stats: CommitStats = { oid: 'abcdef1', additions: 12, deletions: 3, filesChanged: 4 };
    const fixture = render(makeCommit(), makeLane(), false, stats);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="graph-row-stats"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="graph-row-additions"]')?.textContent?.trim()).toBe('+12');
    expect(el.querySelector('[data-testid="graph-row-deletions"]')?.textContent?.trim()).toBe('−3');
    expect(el.querySelector('[data-testid="graph-row-files"]')?.textContent?.trim()).toBe('4f');
    expect(el.querySelector('[data-testid="graph-row-stats"]')?.getAttribute('title')).toBe(
      '12 additions, 3 deletions, 4 files changed',
    );
  });

  it('omits the gauge when stats have not been measured', () => {
    const fixture = render(makeCommit(), makeLane(), false, null);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="graph-row-stats"]')).toBeNull();
    expect(el.querySelector('[data-testid="graph-row-additions"]')).toBeNull();
  });

  // -- branch lens (ADR-0042) ----------------------------------------------

  it('reflects the lens state through the three host classes and data-lens', () => {
    const fixture = render(makeCommit(), makeLane());
    const el = fixture.nativeElement as HTMLElement;

    expect(el.classList.contains('st-graph-row--lens-active')).toBe(false);
    expect(el.getAttribute('data-lens')).toBe('');

    fixture.componentRef.setInput('lensActive', true);
    fixture.componentRef.setInput('inLens', true);
    fixture.detectChanges();

    expect(el.classList.contains('st-graph-row--lens-active')).toBe(true);
    expect(el.classList.contains('st-graph-row--lens-inside')).toBe(true);
    expect(el.classList.contains('st-graph-row--lens-outside')).toBe(false);
    expect(el.getAttribute('data-lens')).toBe('in');

    fixture.componentRef.setInput('inLens', false);
    fixture.detectChanges();

    expect(el.classList.contains('st-graph-row--lens-inside')).toBe(false);
    expect(el.classList.contains('st-graph-row--lens-outside')).toBe(true);
    expect(el.getAttribute('data-lens')).toBe('out');

    fixture.componentRef.setInput('lensActive', false);
    fixture.detectChanges();

    expect(el.classList.contains('st-graph-row--lens-active')).toBe(false);
    expect(el.classList.contains('st-graph-row--lens-outside')).toBe(false);
    expect(el.getAttribute('data-lens')).toBe('');
  });

  it('keeps the selected treatment while exposing the lens state', () => {
    const fixture = render(makeCommit(), makeLane(), true);
    const el = fixture.nativeElement as HTMLElement;

    fixture.componentRef.setInput('lensActive', true);
    fixture.componentRef.setInput('inLens', false);
    fixture.detectChanges();

    // Selection is the stronger state visually (the lens rules are gated on
    // `:not(.st-graph-row--selected)`), while data-lens stays available to
    // tests/assistive tooling.
    expect(el.classList.contains('st-graph-row--selected')).toBe(true);
    expect(el.classList.contains('st-selection-bar')).toBe(true);
    expect(el.classList.contains('st-graph-row--lens-outside')).toBe(true);
    expect(el.getAttribute('data-lens')).toBe('out');
  });
});
