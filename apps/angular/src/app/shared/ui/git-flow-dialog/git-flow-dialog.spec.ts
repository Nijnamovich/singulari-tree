import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GitFlowConfig, GitFlowResult } from '@contracts/gitcore';
import { GitFlowDialog } from './git-flow-dialog';
import { GIT_FLOW_DEFAULTS, type GitFlowFinishValue, type GitFlowStartValue } from './git-flow.models';

interface Options {
  open?: boolean;
  initialMode?: 'start' | 'finish' | 'config';
  config?: GitFlowConfig | null;
  defaultBase?: string;
  running?: boolean;
  error?: { code: string; message: string } | null;
  result?: GitFlowResult | null;
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(GitFlowDialog);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.componentRef.setInput('initialMode', options.initialMode ?? 'start');
  fixture.componentRef.setInput('config', options.config ?? null);
  fixture.componentRef.setInput('defaultBase', options.defaultBase ?? '');
  fixture.componentRef.setInput('running', options.running ?? false);
  fixture.componentRef.setInput('error', options.error ?? null);
  fixture.componentRef.setInput('result', options.result ?? null);
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ReturnType<typeof render>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

/** The `st-button` primitive renders one inner native `<button>`. */
function innerButton(fixture: ReturnType<typeof render>, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

describe('GitFlowDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'git-flow-tab-start')).toBeNull();
  });

  it('opens on the Start tab and emits the start payload', () => {
    const fixture = render({ defaultBase: 'develop' });
    const emitted: GitFlowStartValue[] = [];
    fixture.componentInstance.startSubmitted.subscribe((v) => emitted.push(v));

    expect((query(fixture, 'git-flow-start-base') as HTMLInputElement).value).toBe('develop');

    const kind = query(fixture, 'git-flow-start-kind') as HTMLSelectElement;
    kind.value = 'RELEASE';
    kind.dispatchEvent(new Event('change'));

    const name = query(fixture, 'git-flow-start-name') as HTMLInputElement;
    name.value = '  1.0  ';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    query(fixture, 'git-flow-start-submit')?.click();

    expect(emitted).toEqual([{ kind: 'RELEASE', name: '1.0', base: 'develop' }]);
  });

  it('disables Start until a name is entered', () => {
    const fixture = render();
    expect(innerButton(fixture, 'git-flow-start-submit').disabled).toBe(true);

    const name = query(fixture, 'git-flow-start-name') as HTMLInputElement;
    name.value = 'login';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(innerButton(fixture, 'git-flow-start-submit').disabled).toBe(false);
  });

  it('opens on the Finish tab and emits the finish payload', () => {
    const fixture = render({ initialMode: 'finish' });
    const emitted: GitFlowFinishValue[] = [];
    fixture.componentInstance.finishSubmitted.subscribe((v) => emitted.push(v));

    const name = query(fixture, 'git-flow-finish-name') as HTMLInputElement;
    name.value = 'login';
    name.dispatchEvent(new Event('input'));

    const del = query(fixture, 'git-flow-delete-branch') as HTMLInputElement;
    expect(del.checked).toBe(true);
    del.checked = false;
    del.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    query(fixture, 'git-flow-finish-submit')?.click();

    expect(emitted).toEqual([{ kind: 'FEATURE', name: 'login', deleteBranch: false }]);
  });

  it('switches tabs when a tab is clicked', () => {
    const fixture = render();
    query(fixture, 'git-flow-tab-config')?.click();
    fixture.detectChanges();

    expect(query(fixture, 'git-flow-config-main')).not.toBeNull();
    expect(query(fixture, 'git-flow-start-name')).toBeNull();
  });

  it('seeds the config form from the parent config and emits the edited values', () => {
    const fixture = render({
      initialMode: 'config',
      config: { ...GIT_FLOW_DEFAULTS, mainBranch: 'trunk' },
    });
    let emitted: GitFlowConfig | null = null;
    fixture.componentInstance.configSubmitted.subscribe((v) => (emitted = v));

    expect((query(fixture, 'git-flow-config-main') as HTMLInputElement).value).toBe('trunk');

    const develop = query(fixture, 'git-flow-config-develop') as HTMLInputElement;
    develop.value = 'dev';
    develop.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    query(fixture, 'git-flow-config-submit')?.click();

    expect(emitted).toEqual({ ...GIT_FLOW_DEFAULTS, mainBranch: 'trunk', developBranch: 'dev' });
  });

  it('resets the config form to the conventional defaults', () => {
    const fixture = render({
      initialMode: 'config',
      config: { ...GIT_FLOW_DEFAULTS, mainBranch: 'trunk', featurePrefix: 'feat/' },
    });

    query(fixture, 'git-flow-config-reset')?.click();
    fixture.detectChanges();

    expect((query(fixture, 'git-flow-config-main') as HTMLInputElement).value).toBe('main');
    expect((query(fixture, 'git-flow-config-feature-prefix') as HTMLInputElement).value).toBe(
      'feature/',
    );
  });

  it('adopts an asynchronously loaded config while the form is untouched', () => {
    const fixture = render({ initialMode: 'config', config: null });
    expect((query(fixture, 'git-flow-config-main') as HTMLInputElement).value).toBe('main');

    fixture.componentRef.setInput('config', { ...GIT_FLOW_DEFAULTS, mainBranch: 'trunk' });
    fixture.detectChanges();

    expect((query(fixture, 'git-flow-config-main') as HTMLInputElement).value).toBe('trunk');
  });

  it('does not overwrite user edits when a late config arrives', () => {
    const fixture = render({ initialMode: 'config', config: null });
    const main = query(fixture, 'git-flow-config-main') as HTMLInputElement;
    main.value = 'mine';
    main.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    fixture.componentRef.setInput('config', { ...GIT_FLOW_DEFAULTS, mainBranch: 'trunk' });
    fixture.detectChanges();

    expect((query(fixture, 'git-flow-config-main') as HTMLInputElement).value).toBe('mine');
  });

  it('renders the returned steps and a conflict notice', () => {
    const fixture = render({
      initialMode: 'finish',
      result: { branch: 'release/1.0', steps: ['checkout main', 'merge release/1.0'], hasConflict: true },
    });

    const steps = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="git-flow-step"]'),
    ).map((el) => el.textContent?.trim());
    expect(steps).toEqual(['checkout main', 'merge release/1.0']);
    expect(query(fixture, 'git-flow-conflict')?.textContent).toContain('conflicts');
  });

  it('omits the steps block when there are none', () => {
    const fixture = render({ result: { branch: 'x', steps: [], hasConflict: false } });
    expect(query(fixture, 'git-flow-steps')).toBeNull();
    expect(query(fixture, 'git-flow-conflict')).toBeNull();
  });

  it('surfaces an error and disables actions while running', () => {
    const fixture = render({ running: true, error: { code: 'GIT_FLOW_FAILED', message: 'boom' } });

    expect(query(fixture, 'git-flow-error')?.textContent).toContain('boom');
    expect(innerButton(fixture, 'git-flow-start-submit').disabled).toBe(true);
    expect(innerButton(fixture, 'git-flow-cancel').disabled).toBe(true);
  });

  it('emits cancelled on dismiss', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    query(fixture, 'git-flow-cancel')?.click();

    expect(cancelled).toBe(1);
  });
});
