import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloneDialog } from './clone-dialog';

async function setup(open = true, url = '', error: string | null = null) {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture: ComponentFixture<CloneDialog> = TestBed.createComponent(CloneDialog);
  fixture.componentRef.setInput('open', open);
  fixture.componentRef.setInput('url', url);
  fixture.componentRef.setInput('error', error);
  fixture.detectChanges();
  return fixture;
}

function query<T extends Element>(fixture: ComponentFixture<CloneDialog>, testId: string): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

/** The `st-button` primitive renders one inner native `<button>`. */
function innerButton(fixture: ComponentFixture<CloneDialog>, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

/**
 * Guards the clone dialog stub (ADR-025): it only prefills the URL, the primary
 * action is inert (V1.4), and it surfaces a clipboard validation message.
 */
describe('CloneDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing while closed', async () => {
    const fixture = await setup(false, 'https://example.com/x.git');

    expect(query(fixture, 'clone-url')).toBeNull();
  });

  it('prefills the URL when opened', async () => {
    const fixture = await setup(true, 'https://example.com/x.git');

    expect(query<HTMLInputElement>(fixture, 'clone-url')?.value).toBe(
      'https://example.com/x.git',
    );
    expect(query(fixture, 'clone-note')).not.toBeNull();
  });

  it('keeps the clone action inert (V1.4 stub)', async () => {
    const fixture = await setup(true, 'https://example.com/x.git');

    expect(innerButton(fixture, 'clone-submit').disabled).toBe(true);
  });

  it('shows the validation error instead of the note', async () => {
    const fixture = await setup(true, '', 'The clipboard does not contain a Git URL.');

    expect(query(fixture, 'clone-error')?.textContent).toContain('does not contain a Git URL');
    expect(query(fixture, 'clone-note')).toBeNull();
  });

  it('updates the editable URL field', async () => {
    const fixture = await setup(true, 'https://example.com/x.git');
    const input = query<HTMLInputElement>(fixture, 'clone-url')!;
    input.value = 'git@github.com:org/repo.git';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.urlValue()).toBe('git@github.com:org/repo.git');
  });

  it('emits cancelled from the Cancel button', async () => {
    const fixture = await setup(true, 'https://example.com/x.git');
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);

    query<HTMLButtonElement>(fixture, 'clone-cancel')!.click();

    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
