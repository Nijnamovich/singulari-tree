import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppError } from '@core/services/ipc-bridge.service';
import type { FetchIntent, RemoteOption } from '../../remote-models';
import { FetchDialog } from './fetch-dialog';

const REMOTES: RemoteOption[] = [
  { name: 'origin', url: 'https://example.com/origin.git' },
  { name: 'upstream', url: 'https://example.com/upstream.git' },
];

interface SetupOptions {
  open?: boolean;
  remotes?: RemoteOption[];
  loading?: boolean;
  running?: boolean;
  progress?: { percent: number; message: string } | null;
  error?: AppError | null;
  offline?: boolean;
}

async function setup(opts: SetupOptions = {}): Promise<ComponentFixture<FetchDialog>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(FetchDialog);
  const ref = fixture.componentRef;
  ref.setInput('remotes', opts.remotes ?? REMOTES);
  ref.setInput('loading', opts.loading ?? false);
  ref.setInput('running', opts.running ?? false);
  ref.setInput('progress', opts.progress ?? null);
  ref.setInput('error', opts.error ?? null);
  ref.setInput('offline', opts.offline ?? false);
  ref.setInput('open', opts.open ?? true);
  fixture.detectChanges();
  return fixture;
}

function query<T extends Element>(fixture: ComponentFixture<FetchDialog>, testId: string): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

/** `st-button` forwards the control to its inner native `<button>` (repo-relocate-panel convention). */
function innerButton(fixture: ComponentFixture<FetchDialog>, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

function toggle(fixture: ComponentFixture<FetchDialog>, testId: string, checked: boolean): void {
  const input = query<HTMLInputElement>(fixture, testId)!;
  input.checked = checked;
  input.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

describe('FetchDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing while closed', async () => {
    const fixture = await setup({ open: false });

    expect(query(fixture, 'fetch-dialog')).toBeNull();
    expect(query(fixture, 'modal-title')).toBeNull();
  });

  it('renders the "Fetch" title when open', async () => {
    const fixture = await setup({ open: true });

    expect(query(fixture, 'fetch-dialog')).not.toBeNull();
    expect(query(fixture, 'modal-title')?.textContent?.trim()).toBe('Fetch');
  });

  it('checks all-remotes by default and emits the all-remotes intent', async () => {
    const fixture = await setup();
    const checkbox = query<HTMLInputElement>(fixture, 'fetch-all-remotes')!;
    expect(checkbox.checked).toBe(true);
    expect(query(fixture, 'fetch-remote-select')).toBeNull();

    const intents: FetchIntent[] = [];
    fixture.componentInstance.submitted.subscribe((intent) => intents.push(intent));
    query<HTMLButtonElement>(fixture, 'fetch-submit')!.click();

    expect(intents).toEqual([
      { allRemotes: true, remote: 'origin', prune: false, tags: false, force: false },
    ]);
  });

  it('prefers origin even when it is not the first remote', async () => {
    const fixture = await setup({
      remotes: [
        { name: 'upstream', url: '' },
        { name: 'origin', url: '' },
      ],
    });

    toggle(fixture, 'fetch-all-remotes', false);

    expect(query<HTMLSelectElement>(fixture, 'fetch-remote-select')?.value).toBe('origin');
  });

  it('reveals the remote picker when all-remotes is unchecked and emits the chosen remote', async () => {
    const fixture = await setup();

    toggle(fixture, 'fetch-all-remotes', false);
    const select = query<HTMLSelectElement>(fixture, 'fetch-remote-select')!;
    expect(select).not.toBeNull();
    expect(select.value).toBe('origin');

    select.value = 'upstream';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const intents: FetchIntent[] = [];
    fixture.componentInstance.submitted.subscribe((intent) => intents.push(intent));
    query<HTMLButtonElement>(fixture, 'fetch-submit')!.click();

    expect(intents).toEqual([
      { allRemotes: false, remote: 'upstream', prune: false, tags: false, force: false },
    ]);
  });

  it('renders the option checkboxes enabled and unchecked', async () => {
    const fixture = await setup();

    for (const testId of ['fetch-prune', 'fetch-option-tags', 'fetch-option-overwrite-tags']) {
      const input = query<HTMLInputElement>(fixture, testId)!;
      expect(input.disabled).toBe(false);
      expect(input.checked).toBe(false);
      expect(input.hasAttribute('aria-disabled')).toBe(false);
      expect(query(fixture, `${testId}-deferred`)).toBeNull();
    }
  });

  it('carries prune, tags and force through the emitted intent', async () => {
    const fixture = await setup();
    const intents: FetchIntent[] = [];
    fixture.componentInstance.submitted.subscribe((intent) => intents.push(intent));

    toggle(fixture, 'fetch-prune', true);
    toggle(fixture, 'fetch-option-tags', true);
    toggle(fixture, 'fetch-option-overwrite-tags', true);

    query<HTMLButtonElement>(fixture, 'fetch-submit')!.click();

    expect(intents).toEqual([
      { allRemotes: true, remote: 'origin', prune: true, tags: true, force: true },
    ]);
  });

  it('emits closed when cancel is clicked', async () => {
    const fixture = await setup();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);

    query<HTMLButtonElement>(fixture, 'fetch-cancel')!.click();

    expect(closed).toBe(1);
  });

  it('renders the loading and progress banners', async () => {
    const fixture = await setup({
      loading: true,
      progress: { percent: 42, message: 'Receiving objects' },
    });

    expect(query(fixture, 'fetch-loading')).not.toBeNull();
    const progress = query(fixture, 'fetch-progress');
    expect(progress?.textContent).toContain('42%');
    expect(progress?.textContent).toContain('Receiving objects');
  });

  it('renders the error and offline banners', async () => {
    const fixture = await setup({
      error: { code: 'FETCH_FAILED', message: 'boom' },
      offline: true,
    });

    expect(query(fixture, 'fetch-error')?.textContent).toContain('boom');
    expect(query(fixture, 'fetch-offline')).not.toBeNull();
  });

  it('disables submit while running', async () => {
    const fixture = await setup({ running: true });

    expect(innerButton(fixture, 'fetch-submit').disabled).toBe(true);
  });

  it('disables submit when offline', async () => {
    const fixture = await setup({ offline: true });

    expect(innerButton(fixture, 'fetch-submit').disabled).toBe(true);
  });

  it('disables submit when a specific remote is required but none is selected', async () => {
    const fixture = await setup({ remotes: [] });

    toggle(fixture, 'fetch-all-remotes', false);

    expect(innerButton(fixture, 'fetch-submit').disabled).toBe(true);
  });
});
