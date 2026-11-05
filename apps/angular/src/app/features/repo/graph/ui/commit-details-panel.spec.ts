import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit } from '@contracts/domain';
import { CommitDetailsPanel, TOOLTIP_DELAY_MS } from './commit-details-panel';

const COMMIT: Commit = {
  oid: { hex: 'a'.repeat(40), kind: 'SHA1' },
  parents: [{ hex: 'b'.repeat(40), kind: 'SHA1' }, { hex: 'c'.repeat(40), kind: 'SHA1' }],
  author: { name: 'Ada Lovelace', email: 'ada@example.com', when: '2026-01-02T10:00:00Z' },
  committer: { name: 'Grace Hopper', email: 'grace@example.com', when: '2026-01-02T10:05:00Z' },
  message: 'feat(graph): details panel\n\nfull body text',
  treeOid: undefined,
  committedAt: '2026-01-02T10:05:00Z',
  refs: [
    { name: 'main', kind: 'head' },
    { name: 'v1.0.0', kind: 'tag' },
  ],
};

/** A subject-only commit: no blank line, so there is no description body. */
const SUBJECT_ONLY: Commit = { ...COMMIT, message: 'subject only, no body' };

/** A commit with no message at all: an empty subject AND body. */
const NO_MESSAGE: Commit = { ...COMMIT, message: '   ' };

type PanelInputs = {
  commit?: Commit | null;
  isWip?: boolean;
  showCta?: boolean;
  showSubject?: boolean;
  showFiles?: boolean;
  mode?: 'description' | 'files';
  showViewSwitch?: boolean;
  navMode?: 'none' | 'release' | 'history';
  locked?: boolean;
  showInGraph?: boolean;
  changedFiles?: readonly string[];
  filesSelectable?: boolean;
  selectedPath?: string | null;
};

function render(inputs: PanelInputs = {}): ComponentFixture<CommitDetailsPanel> {
  const fixture = TestBed.createComponent(CommitDetailsPanel);
  fixture.componentRef.setInput('commit', inputs.commit ?? null);
  fixture.componentRef.setInput('isWip', inputs.isWip ?? false);
  fixture.componentRef.setInput('showCta', inputs.showCta ?? false);
  fixture.componentRef.setInput('showSubject', inputs.showSubject ?? true);
  fixture.componentRef.setInput('showFiles', inputs.showFiles ?? false);
  fixture.componentRef.setInput('mode', inputs.mode ?? 'description');
  fixture.componentRef.setInput('showViewSwitch', inputs.showViewSwitch ?? false);
  fixture.componentRef.setInput('navMode', inputs.navMode ?? 'none');
  fixture.componentRef.setInput('locked', inputs.locked ?? false);
  fixture.componentRef.setInput('showInGraph', inputs.showInGraph ?? false);
  fixture.componentRef.setInput('changedFiles', inputs.changedFiles ?? []);
  fixture.componentRef.setInput('filesSelectable', inputs.filesSelectable ?? false);
  fixture.componentRef.setInput('selectedPath', inputs.selectedPath ?? null);
  fixture.detectChanges();
  return fixture;
}

function text(el: HTMLElement, testId: string): string | undefined {
  return el.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim();
}

function button(el: HTMLElement, testId: string): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"] button`);
}

/** jsdom document-order check: is `first` rendered before `second`? */
function isBefore(first: Element, second: Element): boolean {
  return !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** Sets the native filter field's value and dispatches the input event. */
function typeFilter(fixture: ComponentFixture<CommitDetailsPanel>, value: string): void {
  const el = fixture.nativeElement as HTMLElement;
  const field = el.querySelector<HTMLInputElement>('[data-testid="commit-details-files-filter"]');
  if (!field) throw new Error('filter field not found');
  field.value = value;
  field.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

/** Clicks one segment of the exclusive view switch by its value. */
function clickSegment(el: HTMLElement, value: string): void {
  const segment = el.querySelector<HTMLButtonElement>(`[data-testid="toggle-segment-${value}"]`);
  if (!segment) throw new Error(`segment ${value} not found`);
  segment.click();
}

/** Expands the collapsed metadata footer and returns the root element. */
function expandFooter(fixture: ComponentFixture<CommitDetailsPanel>): HTMLElement {
  const el = fixture.nativeElement as HTMLElement;
  const toggle = el.querySelector<HTMLButtonElement>(
    '[data-testid="commit-details-footer-toggle"]',
  );
  if (!toggle) throw new Error('footer toggle not found');
  toggle.click();
  fixture.detectChanges();
  return el;
}

describe('CommitDetailsPanel', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('shows an empty state without a selection', () => {
    const el = render().nativeElement as HTMLElement;
    expect(text(el, 'commit-details-empty')).toContain('Select a commit');
    expect(el.querySelector('[data-testid="commit-details"]')).toBeNull();
  });

  it('renders exactly three regions: header, content and footer', () => {
    const el = render({ commit: COMMIT }).nativeElement as HTMLElement;

    const header = el.querySelector('[data-testid="commit-details-header"]');
    const content = el.querySelector('[data-testid="commit-details-content"]');
    const footer = el.querySelector('[data-testid="commit-details-footer"]');

    expect(header).not.toBeNull();
    expect(content).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(isBefore(header!, content!)).toBe(true);
    expect(isBefore(content!, footer!)).toBe(true);
  });

  it('starts with the metadata footer collapsed', () => {
    const el = render({ commit: COMMIT }).nativeElement as HTMLElement;

    const toggle = el.querySelector<HTMLButtonElement>(
      '[data-testid="commit-details-footer-toggle"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    // Collapsed means the metadata markup is NOT in the DOM.
    expect(el.querySelector('[data-testid="commit-details-meta"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-author"]')).toBeNull();
  });

  it('renders oid, split message, author, committer, date, parents and refs', () => {
    const fixture = render({ commit: COMMIT });
    const el = expandFooter(fixture);

    expect(text(el, 'commit-details-oid')).toBe('a'.repeat(40));
    // The message splits on the first blank line (subject + body); each element
    // now holds exactly one part.
    expect(text(el, 'commit-details-subject')).toBe('feat(graph): details panel');
    expect(text(el, 'commit-details-description')).toBe('full body text');
    expect(text(el, 'commit-details-author')).toContain('Ada Lovelace <ada@example.com>');
    expect(text(el, 'commit-details-committer')).toContain('Grace Hopper <grace@example.com>');
    expect(text(el, 'commit-details-date')).toBe('2026-01-02T10:05:00Z');

    const parents = el.querySelectorAll(
      '[data-testid="commit-details-parents"] .st-commit-details__oid',
    );
    expect(Array.from(parents).map((p) => p.textContent?.trim())).toEqual([
      'b'.repeat(40),
      'c'.repeat(40),
    ]);

    const refs = el.querySelectorAll('[data-testid="commit-details-refs"] .st-commit-details__ref');
    expect(Array.from(refs).map((r) => r.textContent?.trim())).toEqual(['main', 'v1.0.0']);
    expect(text(el, 'commit-details-ref-summary')).toBe('main (head), v1.0.0 (tag)');
  });

  it('renders the short oid with the first seven hex characters', () => {
    const el = render({ commit: COMMIT }).nativeElement as HTMLElement;
    expect(text(el, 'commit-details-short-oid')).toBe('aaaaaaa');
  });

  it('lays the commit out per mode: header → content (subject → body) → footer in description mode', () => {
    const fixture = render({
      commit: COMMIT,
      showCta: true,
      showFiles: true,
      changedFiles: ['src/a.ts'],
    });
    const el = fixture.nativeElement as HTMLElement;

    const order = [
      'commit-details-header',
      'commit-details-content',
      'commit-details-subject',
      'commit-details-description',
      'commit-details-footer',
    ].map((id) => el.querySelector(`[data-testid="${id}"]`));

    order.forEach((node) => expect(node).not.toBeNull());
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(isBefore(order[i]!, order[i + 1]!)).toBe(true);
    }
    // The subject and the body both live INSIDE the content region.
    const content = el.querySelector('[data-testid="commit-details-content"]')!;
    expect(content.contains(el.querySelector('[data-testid="commit-details-subject"]'))).toBe(true);
    expect(content.contains(el.querySelector('[data-testid="commit-details-description"]'))).toBe(
      true,
    );
    expect(el.querySelector('[data-testid="commit-details-files-heading"]')).toBeNull();
  });

  it('lays the commit out per mode: header → content (subject → files) → footer in files mode', () => {
    const fixture = render({
      commit: COMMIT,
      showCta: true,
      showFiles: true,
      showViewSwitch: true,
      mode: 'files',
      changedFiles: ['src/a.ts'],
    });
    const el = fixture.nativeElement as HTMLElement;

    const order = [
      'commit-details-header',
      'commit-details-content',
      'commit-details-subject',
      'commit-details-files-heading',
      'commit-details-files-filter',
      'commit-details-file-path',
      'commit-details-footer',
    ].map((id) => el.querySelector(`[data-testid="${id}"]`));

    order.forEach((node) => expect(node).not.toBeNull());
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(isBefore(order[i]!, order[i + 1]!)).toBe(true);
    }
    // The description body is NOT in the DOM in files mode.
    expect(el.querySelector('[data-testid="commit-details-description"]')).toBeNull();
  });

  it('renders mainline branch refs with the --main pill and other branches with --branch', () => {
    const commit: Commit = {
      ...COMMIT,
      refs: [
        { name: 'main', kind: 'branch' },
        { name: 'master', kind: 'branch' },
        { name: 'feature/x', kind: 'branch' },
      ],
    };
    const el = expandFooter(render({ commit }));

    const refs = el.querySelectorAll<HTMLElement>(
      '[data-testid="commit-details-refs"] .st-commit-details__ref',
    );
    const classes = Array.from(refs).map((ref) => ref.className);

    expect(classes[0]).toContain('st-commit-details__ref--main');
    expect(classes[1]).toContain('st-commit-details__ref--main');
    expect(classes[2]).toContain('st-commit-details__ref--branch');
    expect(classes[2]).not.toContain('st-commit-details__ref--main');
  });

  it('keeps a head-kind ref on the head colour even when it names the mainline', () => {
    // The current branch is reported as kind `head` (see the fixture); only a
    // `branch`-kind ref takes the mint mainline role, matching `st-graph-row`.
    const el = expandFooter(render({ commit: COMMIT }));
    const main = el.querySelector<HTMLElement>(
      '[data-testid="commit-details-refs"] .st-commit-details__ref',
    );
    expect(main?.className).toContain('st-commit-details__ref--head');
    expect(main?.className).not.toContain('st-commit-details__ref--main');
  });

  it('never re-colours a remote or tag ref as mainline', () => {
    const commit: Commit = {
      ...COMMIT,
      refs: [
        { name: 'origin/main', kind: 'remote' },
        { name: 'master', kind: 'tag' },
      ],
    };
    const el = expandFooter(render({ commit }));

    const refs = el.querySelectorAll<HTMLElement>(
      '[data-testid="commit-details-refs"] .st-commit-details__ref',
    );
    const classes = Array.from(refs).map((ref) => ref.className);

    expect(classes[0]).toContain('st-commit-details__ref--remote');
    expect(classes[0]).not.toContain('st-commit-details__ref--main');
    expect(classes[1]).toContain('st-commit-details__ref--tag');
    expect(classes[1]).not.toContain('st-commit-details__ref--main');
  });

  it('renders the 24px initials avatar from the author name', () => {
    const el = expandFooter(render({ commit: COMMIT }));
    // First letters of the first two whitespace-separated words, uppercased.
    expect(text(el, 'commit-details-avatar')).toBe('AL');
  });

  it('falls back to a placeholder avatar when the author is missing', () => {
    const root: Commit = { ...COMMIT, author: undefined };
    const el = expandFooter(render({ commit: root }));
    expect(text(el, 'commit-details-avatar')).toBe('?');
  });

  it('emits reviewChanges exactly once when the primary CTA is clicked', () => {
    const fixture = render({ commit: COMMIT, showCta: true });
    const el = fixture.nativeElement as HTMLElement;
    let emitted = 0;
    fixture.componentInstance.reviewChanges.subscribe(() => (emitted += 1));

    const cta = el.querySelector<HTMLElement>('[data-testid="commit-details-review"]');
    expect(cta).not.toBeNull();
    cta?.click();

    expect(emitted).toBe(1);
  });

  it('omits the primary CTA unless showCta opts in', () => {
    // Default `showCta` is false: a screen that merely reuses this read-only
    // panel (e.g. File status) must not get an inert "Review changes" button.
    expect(
      (render({ commit: COMMIT }).nativeElement as HTMLElement).querySelector(
        '[data-testid="commit-details-review"]',
      ),
    ).toBeNull();
    expect(
      (render({ isWip: true }).nativeElement as HTMLElement).querySelector(
        '[data-testid="commit-details-review"]',
      ),
    ).toBeNull();
    expect(
      (render().nativeElement as HTMLElement).querySelector('[data-testid="commit-details-review"]'),
    ).toBeNull();
  });

  it('marks a root commit when there are no parents and no refs', () => {
    const root: Commit = {
      ...COMMIT,
      parents: [],
      refs: [],
      author: undefined,
      committer: undefined,
    };
    const el = expandFooter(render({ commit: root }));

    expect(text(el, 'commit-details-parents')).toBe('(root commit)');
    expect(text(el, 'commit-details-author')).toBe('—');
    expect(text(el, 'commit-details-ref-summary')).toBe('—');
    expect(el.querySelector('[data-testid="commit-details-refs"]')).toBeNull();
  });

  it('renders the unchanged WIP working-tree state', () => {
    const el = render({ isWip: true, showCta: true }).nativeElement as HTMLElement;
    expect(text(el, 'commit-details-wip')).toContain('Uncommitted changes (WIP)');
    expect(text(el, 'commit-details-wip')).toContain('Working tree');
    expect(el.querySelector('[data-testid="commit-details"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-empty"]')).toBeNull();
    // The WIP branch has no header, so no padlock leaks into it.
    expect(el.querySelector('[data-testid="commit-details-lock"]')).toBeNull();
    // With `showCta` opted in, the CTA is present in the WIP branch too (it
    // routes to file status).
    expect(el.querySelector('[data-testid="commit-details-review"]')).not.toBeNull();
  });

  it('hides the subject headline when showSubject is false (local embed)', () => {
    // History keeps the subject inside the panel.
    const shown = render({ commit: COMMIT }).nativeElement as HTMLElement;
    expect(text(shown, 'commit-details-subject')).toBe('feat(graph): details panel');

    // The File-status LOCAL variant owns this screen's identity, so the panel
    // must not duplicate it. The identity head (hash) is unaffected.
    const hidden = render({ commit: COMMIT, showSubject: false }).nativeElement as HTMLElement;
    expect(hidden.querySelector('[data-testid="commit-details-subject"]')).toBeNull();
    expect(text(hidden, 'commit-details-short-oid')).toBe('aaaaaaa');
  });
});

// -- Exclusive view switch: description XOR changed files ---------------------

describe('CommitDetailsPanel — exclusive view switch', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the switch only when showViewSwitch opts in', () => {
    // Default `showViewSwitch` is false even for a commit that has both sectors
    // available (the analyzer embed owns them itself).
    const off = render({
      commit: COMMIT,
      showFiles: true,
      changedFiles: ['src/a.ts'],
    }).nativeElement as HTMLElement;
    expect(off.querySelector('[data-testid="commit-details-view-switch"]')).toBeNull();

    // WIP and the empty branch never grow a switch either.
    expect(
      (render({ isWip: true, showViewSwitch: true }).nativeElement as HTMLElement).querySelector(
        '[data-testid="commit-details-view-switch"]',
      ),
    ).toBeNull();
    expect(
      (render({ showViewSwitch: true }).nativeElement as HTMLElement).querySelector(
        '[data-testid="commit-details-view-switch"]',
      ),
    ).toBeNull();

    const on = render({
      commit: COMMIT,
      showViewSwitch: true,
      showFiles: true,
      changedFiles: ['src/a.ts'],
    }).nativeElement as HTMLElement;
    expect(on.querySelector('[data-testid="commit-details-view-switch"]')).not.toBeNull();
  });

  it('keeps the two-row header: identity row first, switch row inside the header', () => {
    const el = render({
      commit: COMMIT,
      showCta: true,
      showFiles: true,
      showViewSwitch: true,
      changedFiles: ['src/a.ts'],
    }).nativeElement as HTMLElement;

    const header = el.querySelector('[data-testid="commit-details-header"]')!;
    const row = header.querySelector('.st-commit-details__header-row')!;
    const identity = row.querySelector('.st-commit-details__identity')!;
    const center = row.querySelector('.st-commit-details__header-center')!;
    const actions = row.querySelector('.st-commit-details__actions')!;
    const viewSwitch = el.querySelector('[data-testid="commit-details-view-switch"]')!;

    // Row 1 holds identity → CTA slot → actions, in that order.
    expect(identity).not.toBeNull();
    expect(center).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(isBefore(identity, center)).toBe(true);
    expect(isBefore(center, actions)).toBe(true);

    // Row 2 (the switch) stays inside the header but outside the identity row.
    expect(header.contains(viewSwitch)).toBe(true);
    expect(row.contains(viewSwitch)).toBe(false);
    expect(isBefore(row, viewSwitch)).toBe(true);
  });

  it('renders the host-owned mode: description shows the body, files shows the list', () => {
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      showViewSwitch: true,
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });
    const el = fixture.nativeElement as HTMLElement;

    // Default mode is description: subject + body, no files block.
    expect(text(el, 'commit-details-subject')).toBe('feat(graph): details panel');
    expect(text(el, 'commit-details-description')).toBe('full body text');
    expect(el.querySelector('[data-testid="commit-details-files-heading"]')).toBeNull();

    // The HOST changes the mode; the panel just renders the new input.
    fixture.componentRef.setInput('mode', 'files');
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="commit-details-description"]')).toBeNull();
    expect(text(el, 'commit-details-files-heading')).toBe('2 changed files');
    expect(el.querySelectorAll('[data-testid="commit-details-file-path"]').length).toBe(2);
    // Identity stays visible; the subject is clamped to one line in files mode.
    expect(text(el, 'commit-details-subject')).toBe('feat(graph): details panel');
    expect(
      el
        .querySelector('[data-testid="commit-details-subject"]')
        ?.classList.contains('st-commit-details__subject--collapsed'),
    ).toBe(true);

    fixture.componentRef.setInput('mode', 'description');
    fixture.detectChanges();

    expect(text(el, 'commit-details-description')).toBe('full body text');
    expect(el.querySelector('[data-testid="commit-details-files-heading"]')).toBeNull();
    expect(
      el
        .querySelector('[data-testid="commit-details-subject"]')
        ?.classList.contains('st-commit-details__subject--collapsed'),
    ).toBe(false);
  });

  it('emits modeChange on a segment pick without mutating the rendered mode', () => {
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      showViewSwitch: true,
      changedFiles: ['src/a.ts'],
    });
    const el = fixture.nativeElement as HTMLElement;
    const picks: Array<'description' | 'files'> = [];
    fixture.componentInstance.modeChange.subscribe((value) => picks.push(value));

    clickSegment(el, 'files');
    fixture.detectChanges();

    expect(picks).toEqual(['files']);
    // The host has not fed the mode back yet, so the panel still renders
    // description: the pick is an intent, never internal state.
    expect(text(el, 'commit-details-description')).toBe('full body text');
    expect(el.querySelector('[data-testid="commit-details-files-heading"]')).toBeNull();

    clickSegment(el, 'description');
    fixture.detectChanges();
    expect(picks).toEqual(['files', 'description']);
  });

  it('forces files mode for a commit with NO message at all and disables its description segment', () => {
    const el = render({
      commit: NO_MESSAGE,
      mode: 'description',
      showFiles: true,
      showViewSwitch: true,
      changedFiles: ['src/a.ts'],
    }).nativeElement as HTMLElement;

    const description = el.querySelector<HTMLButtonElement>(
      '[data-testid="toggle-segment-description"]',
    );
    const files = el.querySelector<HTMLButtonElement>('[data-testid="toggle-segment-files"]');
    expect(description?.disabled).toBe(true);
    expect(files?.disabled).toBe(false);
    expect(files?.getAttribute('aria-pressed')).toBe('true');

    expect(text(el, 'commit-details-files-heading')).toBe('1 changed file');
    expect(el.querySelector('[data-testid="commit-details-file-path"]')).not.toBeNull();
    // No subject and no body: the empty heading is not rendered at all.
    expect(el.querySelector('[data-testid="commit-details-subject"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-description"]')).toBeNull();
  });

  it('keeps the description segment enabled for a subject-only commit', () => {
    const el = render({
      commit: SUBJECT_ONLY,
      mode: 'description',
      showFiles: true,
      showViewSwitch: true,
      changedFiles: ['src/a.ts'],
    }).nativeElement as HTMLElement;

    const description = el.querySelector<HTMLButtonElement>(
      '[data-testid="toggle-segment-description"]',
    );
    expect(description?.disabled).toBe(false);
    expect(description?.getAttribute('aria-pressed')).toBe('true');

    // The subject is the description content; there is simply no body paragraph.
    expect(text(el, 'commit-details-subject')).toBe('subject only, no body');
    expect(el.querySelector('[data-testid="commit-details-description"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-files-heading"]')).toBeNull();
  });

  it('keeps the subject visible in both modes (identity, never swapped out)', () => {
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      showViewSwitch: true,
      changedFiles: ['src/a.ts'],
    });
    const el = fixture.nativeElement as HTMLElement;

    expect(text(el, 'commit-details-subject')).toBe('feat(graph): details panel');
    fixture.componentRef.setInput('mode', 'files');
    fixture.detectChanges();
    expect(text(el, 'commit-details-subject')).toBe('feat(graph): details panel');
  });
});

// -- Changed files: a bordered, filterable block inside `files` mode ----------

describe('CommitDetailsPanel — changed files', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  /** Render with the files sector mounted (the host owns the mode input). */
  function renderFiles(fixture: ComponentFixture<CommitDetailsPanel>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('never renders the files sector without showFiles', () => {
    const el = render({
      commit: COMMIT,
      mode: 'files',
      changedFiles: ['src/a.ts'],
    }).nativeElement as HTMLElement;

    // No switch and no files block: the host did not opt into the panel's list.
    expect(el.querySelector('[data-testid="commit-details-view-switch"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-files-heading"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-file-path"]')).toBeNull();
  });

  it('lists the changed file paths as mono rows with an accurate heading', () => {
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      mode: 'files',
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });
    const el = renderFiles(fixture);

    expect(text(el, 'commit-details-files-heading')).toBe('2 changed files');
    const rows = el.querySelectorAll('[data-testid="commit-details-file-path"]');
    expect(Array.from(rows).map((row) => row.textContent?.trim())).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(Array.from(rows).every((row) => row.classList.contains('st-mono'))).toBe(true);
  });

  it('uses the singular heading for a single changed file', () => {
    const fixture = render({ commit: COMMIT, showFiles: true, mode: 'files', changedFiles: ['src/a.ts'] });
    expect(text(renderFiles(fixture), 'commit-details-files-heading')).toBe('1 changed file');
  });

  it('renders the empty-state line when the commit has no changed files', () => {
    const fixture = render({ commit: COMMIT, showFiles: true, mode: 'files', changedFiles: [] });
    const el = renderFiles(fixture);

    expect(text(el, 'commit-details-files-empty')).toContain('No changed files');
    expect(el.querySelector('[data-testid="commit-details-file-path"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-files-filter-empty"]')).toBeNull();
  });

  it('filters case-insensitively and shows the "N of M" heading', () => {
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      mode: 'files',
      changedFiles: ['src/alpha.ts', 'src/beta.ts'],
    });
    const el = renderFiles(fixture);

    typeFilter(fixture, 'BETA');

    expect(text(el, 'commit-details-files-heading')).toBe('1 of 2 changed files');
    const rows = el.querySelectorAll('[data-testid="commit-details-file-path"]');
    expect(Array.from(rows).map((row) => row.textContent?.trim())).toEqual(['src/beta.ts']);
  });

  it('treats filter metacharacters literally (never a RegExp)', () => {
    // `[a]` as a regex char class would also match `src/ab.ts`; includes()
    // matches only the literal `[a]` path.
    const bracket = render({
      commit: COMMIT,
      showFiles: true,
      mode: 'files',
      changedFiles: ['src/[a].ts', 'src/ab.ts'],
    });
    const bracketEl = renderFiles(bracket);
    typeFilter(bracket, '[a]');
    expect(
      Array.from(bracketEl.querySelectorAll('[data-testid="commit-details-file-path"]')).map((r) =>
        r.textContent?.trim(),
      ),
    ).toEqual(['src/[a].ts']);

    // `*.ts` is not a glob: only the path that literally contains it matches.
    const star = render({
      commit: COMMIT,
      showFiles: true,
      mode: 'files',
      changedFiles: ['src/*.ts', 'src/a.ts'],
    });
    const starEl = renderFiles(star);
    typeFilter(star, '*.ts');
    expect(
      Array.from(starEl.querySelectorAll('[data-testid="commit-details-file-path"]')).map((r) =>
        r.textContent?.trim(),
      ),
    ).toEqual(['src/*.ts']);
  });

  it('shows a distinct zero-match state when the filter matches nothing', () => {
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      mode: 'files',
      changedFiles: ['src/alpha.ts', 'src/beta.ts'],
    });
    const el = renderFiles(fixture);

    typeFilter(fixture, 'zzz');

    expect(text(el, 'commit-details-files-filter-empty')).toContain('No files match the filter');
    expect(el.querySelector('[data-testid="commit-details-files-empty"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-file-path"]')).toBeNull();
    expect(text(el, 'commit-details-files-heading')).toBe('0 of 2 changed files');

    // Clearing the filter restores the full list.
    typeFilter(fixture, '');
    expect(el.querySelectorAll('[data-testid="commit-details-file-path"]').length).toBe(2);
    expect(text(el, 'commit-details-files-heading')).toBe('2 changed files');
  });

  it('keeps the files list inside the content region and the footer as a sibling', () => {
    const changedFiles = Array.from({ length: 34 }, (_, index) => `src/dir/file-${index}.ts`);
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      showViewSwitch: true,
      mode: 'files',
      changedFiles,
    });
    const el = fixture.nativeElement as HTMLElement;
    typeFilter(fixture, 'file-2');

    const section = el.querySelector('[data-testid="commit-details"]')!;
    const content = el.querySelector('[data-testid="commit-details-content"]')!;
    const footer = el.querySelector('[data-testid="commit-details-footer"]')!;

    // The list lives INSIDE the content region...
    expect(content.querySelector('[data-testid="commit-details-files-heading"]')).not.toBeNull();
    expect(content.querySelector('[data-testid="commit-details-files-filter"]')).not.toBeNull();
    expect(content.querySelectorAll('[data-testid="commit-details-file-path"]').length).toBeGreaterThan(0);
    expect(text(el, 'commit-details-files-heading')).toContain('of 34 changed files');

    // ...and the footer is its SIBLING, never nested inside it: the file list
    // can never paint over the metadata.
    expect(content.contains(footer)).toBe(false);
    expect(footer.parentElement).toBe(section);
    expect(isBefore(content, footer)).toBe(true);
    expect(footer.querySelector('[data-testid="commit-details-files-heading"]')).toBeNull();
  });

  it('stays read-only: the changed-files block never mounts a diff surface', () => {
    const fixture = render({ commit: COMMIT, showFiles: true, mode: 'files', changedFiles: ['src/a.ts'] });
    const el = renderFiles(fixture);

    // No `st-diff-viewer`, no Monaco, no hunk/code grid: paths only.
    expect(el.querySelector('st-diff-viewer')).toBeNull();
    expect(el.querySelector('[data-testid="diff-viewer"]')).toBeNull();
    expect(el.querySelector('.st-diff-viewer')).toBeNull();
  });

  it('keeps the path rows plain and inert by default (History host)', () => {
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      mode: 'files',
      changedFiles: ['src/a.ts'],
    });
    const el = fixture.nativeElement as HTMLElement;
    let picked: string | null = null;
    fixture.componentInstance.fileSelect.subscribe((path) => (picked = path));

    const row = el.querySelector<HTMLElement>('[data-testid="commit-details-file-path"]')!;
    expect(row.classList.contains('st-commit-details__file-path')).toBe(true);
    expect(row.classList.contains('st-mono')).toBe(true);
    // Exactly History's DOM: no directive classes and no tab stop.
    expect(row.classList.contains('st-selectable-row')).toBe(false);
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(row.hasAttribute('data-selected')).toBe(false);

    row.click();
    expect(picked).toBeNull();
  });

  it('makes the path rows selectable and emits the picked path when the host opts in', () => {
    const fixture = render({
      commit: COMMIT,
      showFiles: true,
      mode: 'files',
      changedFiles: ['src/a.ts', 'src/b.ts'],
      filesSelectable: true,
      selectedPath: 'src/b.ts',
    });
    const el = fixture.nativeElement as HTMLElement;
    const picks: string[] = [];
    fixture.componentInstance.fileSelect.subscribe((path) => picks.push(path));

    const rows = Array.from(
      el.querySelectorAll<HTMLElement>('[data-testid="commit-details-file-path"]'),
    );
    expect(rows).toHaveLength(2);
    // The shared directive marks the row the host's right pane is showing.
    expect(rows[0].classList.contains('st-selectable-row')).toBe(true);
    expect(rows[0].hasAttribute('tabindex')).toBe(true);
    expect(rows[0].getAttribute('data-selected')).toBe('false');
    expect(rows[0].classList.contains('st-selectable-row--selected')).toBe(false);
    expect(rows[1].getAttribute('data-selected')).toBe('true');
    expect(rows[1].classList.contains('st-selectable-row--selected')).toBe(true);

    rows[0].click();
    expect(picks).toEqual(['src/a.ts']);

    // Keyboard activation follows the same directive contract.
    rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(picks).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

// -- Header actions: padlock, contextual nav and show-in-graph ----------------

describe('CommitDetailsPanel — header actions', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders an enabled padlock for a real commit and reflects the pressed state', () => {
    const fixture = render({ commit: COMMIT });
    const el = fixture.nativeElement as HTMLElement;

    const lock = button(el, 'commit-details-lock');
    expect(lock).not.toBeNull();
    expect(lock?.disabled).toBe(false);
    // `st-button` forwards `[pressed]` as `aria-pressed` on the native button.
    expect(lock?.getAttribute('aria-pressed')).toBe('false');
    expect(lock?.getAttribute('aria-label')).toBe('Lock commit');

    const unlockedIcon = lock?.querySelector('svg')?.innerHTML;
    expect(unlockedIcon).toBeTruthy();
    // Unlocked renders the open-padlock shackle.
    expect(unlockedIcon).toContain('9.9-1');

    fixture.componentRef.setInput('locked', true);
    fixture.detectChanges();

    expect(lock?.getAttribute('aria-pressed')).toBe('true');
    expect(lock?.getAttribute('aria-label')).toBe('Unlock commit');
    const lockedIcon = lock?.querySelector('svg')?.innerHTML;
    // The lock/lock-open swap changes the glyph geometry.
    expect(lockedIcon).not.toBe(unlockedIcon);
    expect(lockedIcon).toContain('10 0v4');
  });

  it('disables the padlock without a commit', () => {
    const el = render().nativeElement as HTMLElement;
    const lock = button(el, 'commit-details-lock');
    expect(lock).not.toBeNull();
    expect(lock?.disabled).toBe(true);
  });

  it('emits lockToggle when the padlock is clicked', () => {
    const fixture = render({ commit: COMMIT });
    const el = fixture.nativeElement as HTMLElement;
    let toggled = 0;
    fixture.componentInstance.lockToggle.subscribe(() => (toggled += 1));

    button(el, 'commit-details-lock')?.click();

    expect(toggled).toBe(1);
  });

  it('renders no contextual nav action when navMode is none', () => {
    const el = render({ commit: COMMIT }).nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="commit-details-release"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-history"]')).toBeNull();
  });

  it('renders the release ("Close") action in release mode and emits release', () => {
    const fixture = render({ commit: COMMIT, navMode: 'release' });
    const el = fixture.nativeElement as HTMLElement;
    let released = 0;
    fixture.componentInstance.release.subscribe(() => (released += 1));

    const release = el.querySelector<HTMLElement>('[data-testid="commit-details-release"]');
    expect(release).not.toBeNull();
    expect(release?.textContent).toContain('Close');
    expect(release?.textContent).not.toContain('Back');
    expect(el.querySelector('[data-testid="commit-details-history"]')).toBeNull();

    release?.querySelector('button')?.click();

    expect(released).toBe(1);
  });

  it('renders the history action in history mode and emits openHistory', () => {
    const fixture = render({ commit: COMMIT, navMode: 'history' });
    const el = fixture.nativeElement as HTMLElement;
    let opened = 0;
    fixture.componentInstance.openHistory.subscribe(() => (opened += 1));

    const history = el.querySelector<HTMLElement>('[data-testid="commit-details-history"]');
    expect(history).not.toBeNull();
    expect(history?.textContent).toContain('History');
    expect(el.querySelector('[data-testid="commit-details-release"]')).toBeNull();

    history?.querySelector('button')?.click();

    expect(opened).toBe(1);
  });

  it('renders the empty-branch history shortcut when navMode is history', () => {
    const fixture = render({ navMode: 'history' });
    const el = fixture.nativeElement as HTMLElement;
    let opened = 0;
    fixture.componentInstance.openHistory.subscribe(() => (opened += 1));

    expect(text(el, 'commit-details-empty')).toContain('Select a commit');
    const history = button(el, 'commit-details-history');
    expect(history).not.toBeNull();

    history?.click();

    expect(opened).toBe(1);
  });

  it('renders the analyzer-only show-in-graph action and emits revealInGraph', () => {
    const fixture = render({ commit: COMMIT, showInGraph: true });
    const el = fixture.nativeElement as HTMLElement;
    let revealed = 0;
    fixture.componentInstance.revealInGraph.subscribe(() => (revealed += 1));

    const show = button(el, 'commit-details-show-in-graph');
    expect(show).not.toBeNull();
    expect(show?.getAttribute('aria-label')).toBe('Show in graph');

    show?.click();

    expect(revealed).toBe(1);
  });

  it('hides the show-in-graph action unless showInGraph opts in', () => {
    const el = render({ commit: COMMIT }).nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="commit-details-show-in-graph"]')).toBeNull();
  });
});

// -- Contextual nav tooltip: delayed, copy per action -----------------------

describe('CommitDetailsPanel — contextual nav tooltip', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function tooltip(el: HTMLElement): HTMLElement {
    const node = el.querySelector<HTMLElement>('[data-testid="commit-details-nav-tooltip"]');
    if (!node) throw new Error('nav tooltip not found');
    return node;
  }

  function isHidden(el: HTMLElement): boolean {
    return tooltip(el).classList.contains('st-commit-details__tooltip--hidden');
  }

  it('is in the DOM from the first render, hidden, and described by the control', () => {
    const el = render({ commit: COMMIT, navMode: 'release' }).nativeElement as HTMLElement;

    expect(tooltip(el).getAttribute('role')).toBe('tooltip');
    expect(tooltip(el).getAttribute('id')).toBe('st-commit-details-nav-tooltip');
    expect(isHidden(el)).toBe(true);
    // The description resolves before the delayed bubble appears.
    expect(
      el
        .querySelector('[data-testid="commit-details-release"] button')
        ?.getAttribute('aria-describedby'),
    ).toBe('st-commit-details-nav-tooltip');
  });

  it('reveals "collapse panel" after the delay on continuous hover in release mode', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT, navMode: 'release' });
    const el = fixture.nativeElement as HTMLElement;
    const anchor = el.querySelector<HTMLElement>('[data-testid="commit-details-release"]')!;

    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(true);

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(false);
    expect(tooltip(el).textContent?.trim()).toBe('collapse panel');
  });

  it('treats keyboard focus exactly like hover and hides on blur', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT, navMode: 'release' });
    const el = fixture.nativeElement as HTMLElement;
    const anchor = el.querySelector<HTMLElement>('[data-testid="commit-details-release"]')!;

    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(false);
    expect(tooltip(el).textContent?.trim()).toBe('collapse panel');

    anchor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    fixture.detectChanges();
    expect(isHidden(el)).toBe(true);
  });

  it('hides when hover ends before the delay elapses', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT, navMode: 'release' });
    const el = fixture.nativeElement as HTMLElement;
    const anchor = el.querySelector<HTMLElement>('[data-testid="commit-details-release"]')!;

    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 100);
    anchor.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    expect(isHidden(el)).toBe(true);
  });

  it('anchors the bubble under the control that triggered it', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT, navMode: 'release' });
    const el = fixture.nativeElement as HTMLElement;
    const anchor = el.querySelector<HTMLElement>('[data-testid="commit-details-release"]')!;
    // The anchor's rect is captured at DISPATCH time: `event.currentTarget` is
    // null once the event has been dispatched, so reading it inside the timer
    // would strand the bubble in the viewport's corner.
    anchor.getBoundingClientRect = () =>
      ({
        left: 120,
        bottom: 40,
        top: 20,
        right: 200,
        width: 80,
        height: 20,
        x: 120,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    const bubble = tooltip(el);
    expect(bubble.style.left).toBe('120px');
    expect(bubble.style.top).toBe('46px');
  });

  it('hides the bubble when the pointer leaves AFTER the reveal', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT, navMode: 'release' });
    const el = fixture.nativeElement as HTMLElement;
    const anchor = el.querySelector<HTMLElement>('[data-testid="commit-details-release"]')!;

    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(false);

    // The pointer leaving must take the bubble down, not leave it stuck.
    anchor.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(isHidden(el)).toBe(true);
  });

  it('renders no bubble at all when there is no contextual nav control', () => {
    const el = render({ commit: COMMIT, navMode: 'none' }).nativeElement as HTMLElement;

    // No control, no bubble: an unreferenced tooltip node would only be noise.
    expect(el.querySelector('[data-testid="commit-details-nav-tooltip"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-release"]')).toBeNull();
    expect(el.querySelector('[data-testid="commit-details-history"]')).toBeNull();
  });

  it('reads "follow commit" in history mode and describes the History control', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT, navMode: 'history' });
    const el = fixture.nativeElement as HTMLElement;
    const anchor = el.querySelector<HTMLElement>('[data-testid="commit-details-history"]')!;

    expect(anchor.querySelector('button')?.getAttribute('aria-describedby')).toBe(
      'st-commit-details-nav-tooltip',
    );

    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    expect(isHidden(el)).toBe(false);
    expect(tooltip(el).textContent?.trim()).toBe('follow commit');
  });

  it('hides when the nav mode changes', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT, navMode: 'release' });
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('[data-testid="commit-details-release"]')!.dispatchEvent(
      new MouseEvent('mouseenter'),
    );
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(false);

    fixture.componentRef.setInput('navMode', 'history');
    fixture.detectChanges();
    TestBed.tick();

    expect(isHidden(el)).toBe(true);
  });
});

// -- Padlock tooltip: delayed, viewport-positioned, correctly described ------

describe('CommitDetailsPanel — padlock tooltip', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function lockAnchor(el: HTMLElement): HTMLElement {
    const anchor = el.querySelector<HTMLElement>('.st-commit-details__lock');
    if (!anchor) throw new Error('lock anchor not found');
    return anchor;
  }

  function tooltip(el: HTMLElement): HTMLElement {
    const node = el.querySelector<HTMLElement>('[data-testid="commit-details-lock-tooltip"]');
    if (!node) throw new Error('tooltip not found');
    return node;
  }

  function isHidden(el: HTMLElement): boolean {
    return tooltip(el).classList.contains('st-commit-details__tooltip--hidden');
  }

  it('is always in the DOM (so aria-describedby resolves) but hidden until the delay', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT });
    const el = fixture.nativeElement as HTMLElement;

    // The description exists before the bubble becomes visible, and the
    // padlock points at it from the very first render.
    expect(isHidden(el)).toBe(true);
    const lock = button(el, 'commit-details-lock');
    expect(lock?.getAttribute('aria-describedby')).toBe('st-commit-details-lock-tooltip');

    lockAnchor(el).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(true);

    vi.advanceTimersByTime(1);
    fixture.detectChanges();

    const bubble = tooltip(el);
    expect(isHidden(el)).toBe(false);
    expect(bubble.getAttribute('role')).toBe('tooltip');
    expect(bubble.getAttribute('id')).toBe('st-commit-details-lock-tooltip');
    expect(bubble.textContent).toContain('Locking pins this commit');
  });

  it('hides on mouse leave but keeps aria-describedby', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT });
    const el = fixture.nativeElement as HTMLElement;

    const anchor = lockAnchor(el);
    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(false);

    anchor.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();

    expect(isHidden(el)).toBe(true);
    // The node stays in the accessibility tree: hiding is visual only.
    expect(tooltip(el).textContent).toContain('Locking pins this commit');
    expect(button(el, 'commit-details-lock')?.getAttribute('aria-describedby')).toBe(
      'st-commit-details-lock-tooltip',
    );
  });

  it('treats keyboard focus exactly like hover and hides on blur', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT });
    const el = fixture.nativeElement as HTMLElement;

    const anchor = lockAnchor(el);
    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(false);

    anchor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    fixture.detectChanges();
    expect(isHidden(el)).toBe(true);
  });

  it('hides when the commit changes', () => {
    vi.useFakeTimers();
    const fixture = render({ commit: COMMIT });
    const el = fixture.nativeElement as HTMLElement;

    lockAnchor(el).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(isHidden(el)).toBe(false);

    fixture.componentRef.setInput('commit', SUBJECT_ONLY);
    fixture.detectChanges();
    TestBed.tick();

    expect(isHidden(el)).toBe(true);
  });
});
