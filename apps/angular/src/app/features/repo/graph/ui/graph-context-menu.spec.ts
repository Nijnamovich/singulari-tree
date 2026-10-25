import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RefLabel } from '@contracts/domain';
import { WIP_OID } from '../graph.store';
import {
  type CheckoutTarget,
  type GraphContextMenuTarget,
  type ResetModeName,
} from '../graph-menu.models';
import { GraphContextMenu } from './graph-context-menu';

function makeTarget(refs: RefLabel[] = [], oid = 'a'.repeat(40)): GraphContextMenuTarget {
  return { oid, refs };
}

interface RenderOptions {
  open?: boolean;
  target?: GraphContextMenuTarget | null;
  canCompare?: boolean;
  busy?: boolean;
  lensActive?: boolean;
  currentBranch?: string;
}

function render(options: RenderOptions = {}) {
  const fixture = TestBed.createComponent(GraphContextMenu);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.componentRef.setInput('x', 40);
  fixture.componentRef.setInput('y', 60);
  fixture.componentRef.setInput('target', options.target ?? makeTarget());
  fixture.componentRef.setInput('canCompare', options.canCompare ?? false);
  fixture.componentRef.setInput('busy', options.busy ?? false);
  fixture.componentRef.setInput('lensActive', options.lensActive ?? false);
  fixture.componentRef.setInput('currentBranch', options.currentBranch ?? '');
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ReturnType<typeof render>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

describe('GraphContextMenu', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'graph-context-menu')).toBeNull();
  });

  it('renders the action set and none of the still-excluded entries', () => {
    const fixture = render();
    expect(query(fixture, 'graph-context-menu')).not.toBeNull();
    expect(query(fixture, 'ctx-checkout')).not.toBeNull();
    expect(query(fixture, 'ctx-compare')).not.toBeNull();
    expect(query(fixture, 'ctx-file-status')).not.toBeNull();
    expect(query(fixture, 'ctx-copy-sha')).not.toBeNull();
    expect(query(fixture, 'ctx-create-branch')).not.toBeNull();
    expect(query(fixture, 'ctx-tag')).not.toBeNull();
    expect(query(fixture, 'ctx-reset-soft')).not.toBeNull();
    expect(query(fixture, 'ctx-reset-mixed')).not.toBeNull();
    expect(query(fixture, 'ctx-reset-hard')).not.toBeNull();

    const el = fixture.nativeElement as HTMLElement;
    // The real entry is the lens-tier `ctx-lens-cherry-pick`; the un-lensed tier
    // renders no cherry-pick action at all (ADR-0042).
    expect(query(fixture, 'ctx-lens-cherry-pick')).toBeNull();
    expect(el.textContent ?? '').not.toMatch(/cherry|rebase/i);
  });

  it('renders Revert this commit in the current-branch tier and emits the oid', () => {
    const oid = 'c0ffee'.repeat(7).slice(0, 40);
    const fixture = render({ target: makeTarget([], oid) });
    let emitted: string | undefined;
    fixture.componentInstance.revert.subscribe((value) => (emitted = value));

    const item = query(fixture, 'ctx-revert');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain('Revert this commit');

    item?.click();
    expect(emitted).toBe(oid);
  });

  it('does not emit Revert while busy', () => {
    const fixture = render({ busy: true });
    let emitted = 0;
    fixture.componentInstance.revert.subscribe(() => (emitted += 1));

    expect(query(fixture, 'ctx-revert')?.hasAttribute('disabled')).toBe(true);
    query(fixture, 'ctx-revert')?.click();

    expect(emitted).toBe(0);
  });

  it('emits the full oid for File status and only for a real commit', () => {
    const oid = 'f00d'.repeat(10);
    const fixture = render({ target: makeTarget([], oid) });
    const emitted: string[] = [];
    fixture.componentInstance.fileStatus.subscribe((value) => emitted.push(value));

    expect(query(fixture, 'ctx-file-status')?.textContent?.trim()).toBe('File status');
    expect(query(fixture, 'ctx-file-status')?.hasAttribute('disabled')).toBe(false);

    query(fixture, 'ctx-file-status')?.click();
    expect(emitted).toEqual([oid]);
  });

  it('disables File status for the WIP row and never emits', () => {
    const fixture = render({ target: makeTarget([], WIP_OID) });
    const emitted: string[] = [];
    fixture.componentInstance.fileStatus.subscribe((value) => emitted.push(value));

    expect(query(fixture, 'ctx-file-status')?.hasAttribute('disabled')).toBe(true);
    expect(fixture.componentInstance.canFileStatus()).toBe(false);

    query(fixture, 'ctx-file-status')?.click();
    expect(emitted).toEqual([]);
  });

  it('disables File status for a row without an oid', () => {
    const fixture = render({ target: { oid: '', refs: [] } });
    const emitted: string[] = [];
    fixture.componentInstance.fileStatus.subscribe((value) => emitted.push(value));

    expect(query(fixture, 'ctx-file-status')?.hasAttribute('disabled')).toBe(true);
    query(fixture, 'ctx-file-status')?.click();
    expect(emitted).toEqual([]);
  });

  it('does not emit File status while busy', () => {
    const fixture = render({ busy: true });
    const emitted: string[] = [];
    fixture.componentInstance.fileStatus.subscribe((value) => emitted.push(value));

    expect(query(fixture, 'ctx-file-status')?.hasAttribute('disabled')).toBe(true);
    query(fixture, 'ctx-file-status')?.click();
    expect(emitted).toEqual([]);
  });

  it('emits the full oid for Create branch here', () => {
    const oid = 'abcd'.repeat(10);
    const fixture = render({ target: makeTarget([], oid) });
    let emitted: string | undefined;
    fixture.componentInstance.createBranchHere.subscribe((value) => (emitted = value));

    query(fixture, 'ctx-create-branch')?.click();

    expect(emitted).toBe(oid);
  });

  it('emits the full oid for Tag this commit', () => {
    const oid = 'beef'.repeat(10);
    const fixture = render({ target: makeTarget([], oid) });
    let emitted: string | undefined;
    fixture.componentInstance.tagCommit.subscribe((value) => (emitted = value));

    query(fixture, 'ctx-tag')?.click();

    expect(emitted).toBe(oid);
  });

  it('positions the menu at the given coordinates', () => {
    const fixture = render();
    const menu = query(fixture, 'graph-context-menu');
    expect(menu?.style.left).toBe('40px');
    expect(menu?.style.top).toBe('60px');
  });

  it('resolves a local branch ref as the checkout target', () => {
    const fixture = render({ target: makeTarget([{ name: 'feature/x', kind: 'branch' }]) });
    let emitted: CheckoutTarget | undefined;
    fixture.componentInstance.checkout.subscribe((value) => (emitted = value));

    query(fixture, 'ctx-checkout')?.click();

    expect(emitted).toEqual({ refName: 'feature/x', isRemote: false, label: 'feature/x' });
    expect(query(fixture, 'ctx-checkout-target')?.textContent?.trim()).toBe('feature/x');
  });

  it('resolves a remote-tracking ref as a remote checkout', () => {
    const fixture = render({ target: makeTarget([{ name: 'origin/main', kind: 'remote' }]) });
    let emitted: CheckoutTarget | undefined;
    fixture.componentInstance.checkout.subscribe((value) => (emitted = value));

    query(fixture, 'ctx-checkout')?.click();

    expect(emitted).toEqual({ refName: 'origin/main', isRemote: true, label: 'origin/main' });
  });

  it('falls back to a detached checkout of the oid when no branch ref exists', () => {
    const oid = 'deadbeef'.repeat(5);
    const fixture = render({ target: makeTarget([{ name: 'v1.0.0', kind: 'tag' }], oid) });
    let emitted: CheckoutTarget | undefined;
    fixture.componentInstance.checkout.subscribe((value) => (emitted = value));

    query(fixture, 'ctx-checkout')?.click();

    expect(emitted?.refName).toBe(oid);
    expect(emitted?.isRemote).toBe(false);
    expect(emitted?.label).toBe(oid.slice(0, 7));
  });

  it('drives the Compare item disabled state from the canCompare input', () => {
    const withoutBase = render({ canCompare: false });
    expect(query(withoutBase, 'ctx-compare')?.hasAttribute('disabled')).toBe(true);

    const withBase = render({ canCompare: true });
    const item = query(withBase, 'ctx-compare');
    expect(item?.hasAttribute('disabled')).toBe(false);

    let compared = 0;
    withBase.componentInstance.compare.subscribe(() => (compared += 1));
    item?.click();
    expect(compared).toBe(1);
  });

  it('does not emit compare when disabled', () => {
    const fixture = render({ canCompare: false });
    let compared = 0;
    fixture.componentInstance.compare.subscribe(() => (compared += 1));

    query(fixture, 'ctx-compare')?.click();

    expect(compared).toBe(0);
  });

  it('emits the full oid for Copy SHA', () => {
    const oid = '1234567890'.repeat(4);
    const fixture = render({ target: makeTarget([], oid) });
    let copied: string | undefined;
    fixture.componentInstance.copySha.subscribe((value) => (copied = value));

    query(fixture, 'ctx-copy-sha')?.click();

    expect(copied).toBe(oid);
  });

  it('emits SOFT, MIXED and HARD for the reset entries', () => {
    const fixture = render();
    const modes: ResetModeName[] = [];
    fixture.componentInstance.reset.subscribe((mode) => modes.push(mode));

    query(fixture, 'ctx-reset-soft')?.click();
    query(fixture, 'ctx-reset-mixed')?.click();
    query(fixture, 'ctx-reset-hard')?.click();

    expect(modes).toEqual(['SOFT', 'MIXED', 'HARD']);
  });

  it('disables every entry while busy and emits nothing', () => {
    const fixture = render({ busy: true, canCompare: true });
    let emitted = 0;
    fixture.componentInstance.checkout.subscribe(() => (emitted += 1));
    fixture.componentInstance.compare.subscribe(() => (emitted += 1));
    fixture.componentInstance.createBranchHere.subscribe(() => (emitted += 1));
    fixture.componentInstance.tagCommit.subscribe(() => (emitted += 1));
    fixture.componentInstance.revert.subscribe(() => (emitted += 1));
    fixture.componentInstance.reset.subscribe(() => (emitted += 1));

    expect(query(fixture, 'ctx-checkout')?.hasAttribute('disabled')).toBe(true);
    expect(query(fixture, 'ctx-create-branch')?.hasAttribute('disabled')).toBe(true);
    expect(query(fixture, 'ctx-tag')?.hasAttribute('disabled')).toBe(true);
    expect(query(fixture, 'ctx-revert')?.hasAttribute('disabled')).toBe(true);
    query(fixture, 'ctx-checkout')?.click();
    query(fixture, 'ctx-compare')?.click();
    query(fixture, 'ctx-create-branch')?.click();
    query(fixture, 'ctx-tag')?.click();
    query(fixture, 'ctx-revert')?.click();
    query(fixture, 'ctx-reset-soft')?.click();

    expect(emitted).toBe(0);
  });

  it('closes on an outside click', () => {
    const fixture = render();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => (closed += 1));

    query(fixture, 'ctx-backdrop')?.click();

    expect(closed).toBe(1);
  });

  it('closes on a backdrop context-menu gesture', () => {
    const fixture = render();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => (closed += 1));

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    query(fixture, 'ctx-backdrop')?.dispatchEvent(event);

    expect(closed).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('closes on Escape', () => {
    const fixture = render();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => (closed += 1));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(closed).toBe(1);
  });

  it('moves focus between enabled items with ArrowDown/ArrowUp', () => {
    const fixture = render({ canCompare: true });
    const el = fixture.nativeElement as HTMLElement;
    const items = Array.from(
      el.querySelectorAll<HTMLElement>('.st-graph-context-menu__item:not(:disabled)'),
    );
    const menu = query(fixture, 'graph-context-menu') as HTMLElement;

    items[0]?.focus();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('focuses the first item on ArrowDown when nothing is focused yet', () => {
    const fixture = render({ canCompare: true });
    const el = fixture.nativeElement as HTMLElement;
    const items = Array.from(
      el.querySelectorAll<HTMLElement>('.st-graph-context-menu__item:not(:disabled)'),
    );
    const menu = query(fixture, 'graph-context-menu') as HTMLElement;
    (document.activeElement as HTMLElement | null)?.blur();

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(document.activeElement).toBe(items[0]);
  });

  it('closes on Escape pressed inside the menu', () => {
    const fixture = render();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => (closed += 1));
    const menu = query(fixture, 'graph-context-menu') as HTMLElement;

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(closed).toBe(1);
  });

  // -- lens tier (ADR-0042) -------------------------------------------------

  it('renders exactly three entries while a lens is active and no ref mutations', () => {
    const fixture = render({ lensActive: true, currentBranch: 'main' });
    const el = fixture.nativeElement as HTMLElement;
    const items = Array.from(el.querySelectorAll<HTMLElement>('.st-graph-context-menu__item'));

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.getAttribute('data-testid'))).toEqual([
      'ctx-lens-cherry-pick',
      'ctx-copy-sha',
      'ctx-file-status',
    ]);

    for (const excluded of [
      'ctx-checkout',
      'ctx-compare',
      'ctx-create-branch',
      'ctx-tag',
      'ctx-revert',
      'ctx-reset-soft',
      'ctx-reset-mixed',
      'ctx-reset-hard',
    ]) {
      expect(query(fixture, excluded)).toBeNull();
    }
    // No reset group/separator leaks into the lens tier either.
    expect(el.querySelectorAll('.st-graph-context-menu__separator')).toHaveLength(0);
    expect(el.querySelectorAll('.st-graph-context-menu__group')).toHaveLength(0);
    // The stale non-lens id is not the real entry, so it must not appear here.
    expect(query(fixture, 'ctx-cherry-pick')).toBeNull();
  });

  it('names the current branch as the cherry-pick destination and emits the oid', () => {
    const oid = 'beef'.repeat(10);
    const fixture = render({
      lensActive: true,
      currentBranch: 'feature/x',
      target: makeTarget([], oid),
    });
    let emitted: string | undefined;
    fixture.componentInstance.lensCherryPick.subscribe((value) => (emitted = value));

    const item = query(fixture, 'ctx-lens-cherry-pick') as HTMLElement;
    expect(item.textContent).toContain('Cherry-pick onto');
    expect(item.textContent).toContain('feature/x');

    item.click();

    expect(emitted).toBe(oid);
  });

  it('names a detached HEAD as the cherry-pick destination when no branch is current', () => {
    const fixture = render({ lensActive: true, currentBranch: '' });
    const item = query(fixture, 'ctx-lens-cherry-pick') as HTMLElement;

    expect(item.textContent).toContain('Cherry-pick onto');
    expect(item.textContent).toContain('detached HEAD');
  });

  it('does not emit cherry-pick while busy', () => {
    const fixture = render({ lensActive: true, busy: true });
    let emitted = 0;
    fixture.componentInstance.lensCherryPick.subscribe(() => (emitted += 1));

    expect(query(fixture, 'ctx-lens-cherry-pick')?.hasAttribute('disabled')).toBe(true);
    query(fixture, 'ctx-lens-cherry-pick')?.click();

    expect(emitted).toBe(0);
  });

  it('keeps ArrowDown/ArrowUp focus movement inside the lens tier', () => {
    const fixture = render({ lensActive: true, currentBranch: 'main' });
    const el = fixture.nativeElement as HTMLElement;
    const items = Array.from(
      el.querySelectorAll<HTMLElement>('.st-graph-context-menu__item:not(:disabled)'),
    );
    const menu = query(fixture, 'graph-context-menu') as HTMLElement;

    items[0]?.focus();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('renders the full entry set (including Reset) with no lens active', () => {
    const fixture = render({ lensActive: false });

    expect(query(fixture, 'ctx-checkout')).not.toBeNull();
    expect(query(fixture, 'ctx-compare')).not.toBeNull();
    expect(query(fixture, 'ctx-create-branch')).not.toBeNull();
    expect(query(fixture, 'ctx-tag')).not.toBeNull();
    expect(query(fixture, 'ctx-revert')).not.toBeNull();
    expect(query(fixture, 'ctx-reset-soft')).not.toBeNull();
    expect(query(fixture, 'ctx-reset-mixed')).not.toBeNull();
    expect(query(fixture, 'ctx-reset-hard')).not.toBeNull();
    expect(query(fixture, 'ctx-lens-cherry-pick')).toBeNull();
  });
});
