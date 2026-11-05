import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SwitchBranchConfirmDialog, type SwitchBranchMode } from './switch-branch-confirm-dialog';

interface SetupOptions {
  open?: boolean;
  branchName?: string;
  mode?: SwitchBranchMode;
}

async function setup(
  opts: SetupOptions = {},
): Promise<ComponentFixture<SwitchBranchConfirmDialog>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(SwitchBranchConfirmDialog);
  const ref = fixture.componentRef;
  ref.setInput('open', opts.open ?? true);
  ref.setInput('branchName', opts.branchName ?? 'feature/x');
  ref.setInput('mode', opts.mode ?? 'dirty');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

function query<T extends Element>(
  fixture: ComponentFixture<SwitchBranchConfirmDialog>,
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

/** `st-button` forwards the control to its inner native `<button>` (repo-relocate-panel convention). */
function innerButton(
  fixture: ComponentFixture<SwitchBranchConfirmDialog>,
  testId: string,
): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

/** Collapse template whitespace so copy assertions do not depend on wrapping. */
function textOf(
  fixture: ComponentFixture<SwitchBranchConfirmDialog>,
  testId: string,
): string {
  return query(fixture, testId)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('SwitchBranchConfirmDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing while closed', async () => {
    const fixture = await setup({ open: false });

    expect(query(fixture, 'switch-branch-message')).toBeNull();
  });

  it('renders the exact dirty confirmation copy with the clicked branch name', async () => {
    const fixture = await setup({ branchName: 'feature/x' });

    expect(textOf(fixture, 'switch-branch-message')).toBe(
      "Are you sure you want to switch your working copy to a branch 'feature/x'?",
    );
  });

  it('states that Force checkout discards all uncommitted tracked changes', async () => {
    const fixture = await setup();

    expect(textOf(fixture, 'switch-branch-hint')).toContain(
      'Force checkout discards ALL uncommitted tracked changes.',
    );
  });

  it('renders the force checkbox unchecked by default', async () => {
    const fixture = await setup();

    const checkbox = query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
  });

  it('arms Force checkout only after the force checkbox is ticked', async () => {
    const fixture = await setup();

    expect(innerButton(fixture, 'switch-branch-force').disabled).toBe(true);

    const checkbox = query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(innerButton(fixture, 'switch-branch-force').disabled).toBe(false);
  });

  it('emits forceCheckout when the armed Force checkout button is clicked', async () => {
    const fixture = await setup();
    let emitted = 0;
    fixture.componentInstance.forceCheckout.subscribe(() => emitted++);

    const checkbox = query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    innerButton(fixture, 'switch-branch-force').click();

    expect(emitted).toBe(1);
  });

  it('emits saveChanges from the Save changes (stash) action', async () => {
    const fixture = await setup();
    let emitted = 0;
    fixture.componentInstance.saveChanges.subscribe(() => emitted++);

    innerButton(fixture, 'switch-branch-save').click();

    expect(emitted).toBe(1);
  });

  it('emits cancel from the Cancel action', async () => {
    const fixture = await setup();
    let emitted = 0;
    fixture.componentInstance.cancel.subscribe(() => emitted++);

    innerButton(fixture, 'switch-branch-cancel').click();

    expect(emitted).toBe(1);
  });

  it('emits cancel when the modal is closed via Escape', async () => {
    const fixture = await setup();
    let emitted = 0;
    fixture.componentInstance.cancel.subscribe(() => emitted++);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(emitted).toBe(1);
  });

  it('renders the untracked warning and a delete action in untracked mode', async () => {
    const fixture = await setup({ mode: 'untracked', branchName: 'main' });

    expect(textOf(fixture, 'switch-branch-message')).toBe(
      "Switching your working copy to a branch 'main' will permanently delete untracked files.",
    );
    // The clean is `-fd` (not `-x`): ALL untracked files/folders go, ignored stay.
    expect(textOf(fixture, 'switch-branch-warning')).toBe(
      'All untracked files and folders will be permanently deleted. Ignored files are kept.',
    );
    expect(query(fixture, 'switch-branch-force-checkbox')).toBeNull();

    let emitted = 0;
    fixture.componentInstance.forceCheckout.subscribe(() => emitted++);
    innerButton(fixture, 'switch-branch-force').click();
    expect(emitted).toBe(1);
  });

  // -- confirm mode (every branch switch) ----------------------------------

  it('renders the exact confirm copy with an unchecked force checkbox by default', async () => {
    const fixture = await setup({ mode: 'confirm', branchName: 'feature/x' });

    expect(textOf(fixture, 'switch-branch-message')).toBe(
      "Are you sure you want to switch your working copy to a branch 'feature/x'?",
    );
    const checkbox = query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
    // Confirm mode shows neither the dirty hint nor the untracked warning.
    expect(query(fixture, 'switch-branch-hint')).toBeNull();
    expect(query(fixture, 'switch-branch-warning')).toBeNull();
  });

  it('keeps the Switch action enabled regardless of the force checkbox', async () => {
    const fixture = await setup({ mode: 'confirm' });
    const button = innerButton(fixture, 'switch-branch-confirm');

    expect(button.disabled).toBe(false);

    const checkbox = query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(button.disabled).toBe(false);
  });

  it('emits confirmed(false) from Switch when force is unchecked', async () => {
    const fixture = await setup({ mode: 'confirm' });
    const emitted: boolean[] = [];
    fixture.componentInstance.confirmed.subscribe((v) => emitted.push(v));

    innerButton(fixture, 'switch-branch-confirm').click();

    expect(emitted).toEqual([false]);
  });

  it('emits confirmed(true) from Switch when force is checked', async () => {
    const fixture = await setup({ mode: 'confirm' });
    const emitted: boolean[] = [];
    fixture.componentInstance.confirmed.subscribe((v) => emitted.push(v));

    const checkbox = query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    innerButton(fixture, 'switch-branch-confirm').click();

    expect(emitted).toEqual([true]);
  });

  it('emits cancel (and not confirmed) from the Cancel action in confirm mode', async () => {
    const fixture = await setup({ mode: 'confirm' });
    let cancels = 0;
    let confirms = 0;
    fixture.componentInstance.cancel.subscribe(() => cancels++);
    fixture.componentInstance.confirmed.subscribe(() => confirms++);

    innerButton(fixture, 'switch-branch-cancel').click();

    expect(cancels).toBe(1);
    expect(confirms).toBe(0);
  });
});
